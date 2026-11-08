import { createHash, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'crypto';
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabaseAdmin } from './supabaseClient';

type Role = 'buyer' | 'seller';
type LocationInput =
  | { source: 'saved'; location_id: string }
  | { source: 'device'; latitude: number; longitude: number };

const TRUSTEA_COLLECTION_POINT = {
  name: 'COLLECTION POINT',
  address: '35 NALIKWANDA ROAD',
  latitude: -15.4390139,
  longitude: 28.3478109,
  phone: '+260978587417'
};

class FulfilmentError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function route(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function db() {
  if (!supabaseAdmin) {
    throw new FulfilmentError(503, 'Fulfilment is not configured. Set SUPABASE_SERVICE_ROLE_KEY on the hub.');
  }
  return supabaseAdmin;
}

function requireText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new FulfilmentError(400, `Enter a valid ${name}.`);
  }
  return value.trim();
}

function normalizePhone(value: unknown, name: string): string {
  const phone = requireText(value, name, 20);
  if (!/^\+?[0-9 ()-]{7,20}$/.test(phone) || phone.replace(/\D/g, '').length < 7) {
    throw new FulfilmentError(400, `Enter a valid ${name}.`);
  }
  return phone.replace(/[ ()-]/g, '');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function encryptionKey(): Buffer {
  const configured = process.env.FULFILMENT_TOKEN_ENCRYPTION_KEY;
  if (!configured || configured.length < 32) {
    throw new FulfilmentError(503, 'Set FULFILMENT_TOKEN_ENCRYPTION_KEY to a secret of at least 32 characters.');
  }
  return createHash('sha256').update(configured).digest();
}

function encryptToken(token: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}

function decryptToken(value: string): string {
  const [nonce, tag, ciphertext] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  if (!nonce || !tag || !ciphertext) throw new FulfilmentError(500, 'The transaction link could not be restored.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

type AuthenticatedTrusteaUser = {
  id: string;
  accessToken: string;
  claims: { aal?: string; amr?: unknown } | null;
};

async function authenticateTrusteaUser(req: Request): Promise<AuthenticatedTrusteaUser> {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!match) throw new FulfilmentError(401, 'Sign in to use your BuySafe inbox.');
  const { data, error } = await db().auth.getUser(match[1]);
  if (error || !data.user) throw new FulfilmentError(401, 'Your sign-in has expired. Sign in again.');

  let claims: AuthenticatedTrusteaUser['claims'] = null;
  try {
    const payload = match[1].split('.')[1];
    if (payload) claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    claims = null;
  }
  return { id: data.user.id, accessToken: match[1], claims };
}

function verifyFleetbaseWebhookToken(req: Request): void {
  const configuredToken = process.env.FLEETBASE_WEBHOOK_TOKEN;
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!configuredToken) throw new FulfilmentError(503, 'Fleetbase webhook verification is not configured.');
  const expected = Buffer.from(configuredToken);
  const supplied = Buffer.from(match?.[1] || req.get('x-fleetbase-webhook-token') || String(req.query.token || ''));
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new FulfilmentError(401, 'Invalid Fleetbase webhook token.');
  }
}

function getPublicUrl(): string {
  return (process.env.FULFILMENT_APP_URL || 'http://localhost:3003').replace(/\/+$/, '');
}

function participantUrl(id: string, token: string): string {
  const sumthinUrl = process.env.SUMTHIN_APP_URL;
  const url = new URL(sumthinUrl ? sumthinUrl.replace(/\/+$/, '') : `${getPublicUrl()}/fulfilment`);
  url.searchParams.set('transaction', id);
  url.searchParams.set('token', token);
  return url.toString();
}

async function queueSms(phone: string, message: string, transactionId: string, smsType: string): Promise<void> {
  const { error } = await db().from('send_sms').insert({
    recipient: phone,
    phone,
    message,
    processed: false,
    status: 'pending',
    sms_type: smsType,
    metadata: { transaction_id: transactionId }
  });
  if (error) {
    console.error('[Fulfilment] Failed to queue SMS:', error.message);
    throw new FulfilmentError(502, 'The transaction was saved, but its SMS could not be queued. Please retry.');
  }
}

async function addEvent(transactionId: string, eventType: string, description: string): Promise<void> {
  const { error } = await db().from('fulfilment_events').insert({
    transaction_id: transactionId,
    event_type: eventType,
    description
  });
  if (error) {
    console.error('[Fulfilment] Failed to save event:', error.message);
    throw new FulfilmentError(502, 'The transaction changed, but its activity could not be saved.');
  }
}

async function loadTransaction(id: string): Promise<any> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new FulfilmentError(400, 'Invalid transaction link.');
  const { data, error } = await db().from('fulfilment_transactions').select('*').eq('id', id).maybeSingle();
  if (error) throw new FulfilmentError(502, 'Could not load this transaction.');
  if (!data) throw new FulfilmentError(404, 'This transaction link is no longer available.');
  return data;
}

async function authorizeParticipant(req: Request): Promise<{ transaction: any; role: Role }> {
  const id = requireText(req.params.id, 'transaction link', 80);
  const token = requireText(req.query.token, 'private transaction link', 200);
  const transaction = await loadTransaction(id);
  const hash = tokenHash(token);
  if (equalHash(hash, transaction.buyer_token_hash)) return { transaction, role: 'buyer' };
  if (equalHash(hash, transaction.seller_token_hash)) return { transaction, role: 'seller' };
  throw new FulfilmentError(403, 'This private transaction link is invalid.');
}

async function resolveLocation(input: LocationInput): Promise<any> {
  if (!input || (input.source !== 'saved' && input.source !== 'device')) {
    throw new FulfilmentError(400, 'Choose a saved location or share your device location.');
  }
  if (input.source === 'saved') {
    if (!/^[0-9a-f-]{36}$/i.test(input.location_id)) throw new FulfilmentError(400, 'Choose a valid saved location.');
    const { data, error } = await db().from('fulfilment_locations')
      .select('id, label, address, latitude, longitude')
      .eq('id', input.location_id)
      .eq('active', true)
      .maybeSingle();
    if (error) throw new FulfilmentError(502, 'Could not load the selected saved location.');
    if (!data) throw new FulfilmentError(400, 'That saved location is no longer available.');
    return { ...data, source: 'saved' };
  }
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new FulfilmentError(400, 'Share a valid device location.');
  }
  return {
    label: 'Current device location',
    address: `Current device location (${latitude.toFixed(5)}, ${longitude.toFixed(5)})`,
    latitude,
    longitude,
    source: 'device'
  };
}

function safeTransaction(transaction: any, role: Role, photos: string[], events: any[]) {
  const { buyer_phone, seller_phone, buyer_name, buyer_token_hash, seller_token_hash, buyer_token_ciphertext, seller_token_ciphertext, buyer_user_id, seller_user_id, photo_paths, ...shared } = transaction;
  return {
    ...shared,
    buyer_name: role === 'buyer' ? buyer_name : undefined,
    role,
    phone: role === 'buyer' ? buyer_phone : seller_phone,
    origin: role === 'seller' ? transaction.origin : undefined,
    destination: role === 'buyer' ? transaction.destination : undefined,
    photos,
    events
  };
}

async function transactionView(transaction: any, role: Role) {
  let photos: string[] = [];
  if (transaction.photo_paths?.length) {
    const { data, error } = await db().storage.from('fulfilment-photos')
      .createSignedUrls(transaction.photo_paths, 900);
    if (error) throw new FulfilmentError(502, 'Could not load item photos.');
    photos = (data || []).flatMap(item => item.signedUrl ? [item.signedUrl] : []);
  }
  const { data: events, error } = await db().from('fulfilment_events')
    .select('id, event_type, description, created_at')
    .eq('transaction_id', transaction.id)
    .order('created_at', { ascending: true });
  if (error) throw new FulfilmentError(502, 'Could not load transaction activity.');
  return safeTransaction(transaction, role, photos, events || []);
}

async function checkReturnWindow(transaction: any): Promise<any> {
  if (transaction.status !== 'return_window' || !transaction.return_window_ends_at ||
      new Date(transaction.return_window_ends_at).getTime() > Date.now()) return transaction;

  const now = new Date().toISOString();
  const { data, error } = await db().from('fulfilment_transactions')
    .update({ status: 'settlement_due', updated_at: now })
    .eq('id', transaction.id)
    .eq('status', 'return_window')
    .select('*')
    .maybeSingle();
  if (error) throw new FulfilmentError(502, 'Could not close the return window.');
  if (!data) return loadTransaction(transaction.id);

  await addEvent(transaction.id, 'return_window_ended', 'The 24-hour return window ended. Seller settlement and loan origination are ready for MFI review.');
  const buyerUrl = participantUrl(data.id, decryptToken(data.buyer_token_ciphertext));
  const sellerUrl = participantUrl(data.id, decryptToken(data.seller_token_ciphertext));
  await Promise.all([
    queueSms(data.buyer_phone, `The return window for transaction ${data.id.slice(0, 8)} has ended. Settlement is ready for final confirmation: ${buyerUrl}`, data.id, 'return_window_ended'),
    queueSms(data.seller_phone, `The return window for transaction ${data.id.slice(0, 8)} has ended. Settlement is ready for final confirmation: ${sellerUrl}`, data.id, 'return_window_ended')
  ]);
  return data;
}

type FleetbaseOrder = {
  orderId: string;
  status: string;
  trackingUrl: string | null;
};

function fleetbaseConsoleUrl(path: string): string {
  const base = (process.env.FLEETBASE_CONSOLE_URL || 'https://console.fleetbase.io').replace(/\/+$/, '');
  return `${base}/${path.replace(/^\/+/, '')}`;
}

function trackingCode(value: unknown, depth = 0): string | null {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text && text !== '[object Object]' && !/^https?:\/\//i.test(text) ? text : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth >= 3) return null;

  const record = value as Record<string, unknown>;
  for (const key of ['tracking_number', 'trackingNumber', 'tracking_code', 'trackingCode', 'tracking_id', 'trackingId', 'number', 'code']) {
    const code = trackingCode(record[key], depth + 1);
    if (code) return code;
  }
  for (const key of ['tracking', 'tracking_details', 'trackingDetails', 'attributes', 'data']) {
    const code = trackingCode(record[key], depth + 1);
    if (code) return code;
  }
  return null;
}

function explicitTrackingUrl(value: unknown, depth = 0): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    let decodedText = text;
    try {
      decodedText = decodeURIComponent(text);
    } catch {
      // The URL constructor below will reject malformed URL input if necessary.
    }
    if (!text || decodedText.toLowerCase().includes('[object object]') ||
        (!/^https?:\/\//i.test(text) && !/^(?:\/|~\/)/.test(text))) return null;
    try {
      const url = new URL(text, process.env.FLEETBASE_CONSOLE_URL || 'https://console.fleetbase.io');
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth >= 3) return null;

  const record = value as Record<string, unknown>;
  for (const key of ['tracking_url', 'trackingUrl', 'tracking_link', 'trackingLink', 'public_tracking_url', 'publicTrackingUrl', 'url']) {
    const url = explicitTrackingUrl(record[key], depth + 1);
    if (url) return url;
  }
  for (const key of ['tracking', 'tracking_details', 'trackingDetails', 'attributes', 'data']) {
    const url = explicitTrackingUrl(record[key], depth + 1);
    if (url) return url;
  }
  return null;
}

function resolveFleetbaseTrackingUrl(...sources: unknown[]): string | null {
  for (const source of sources) {
    const url = explicitTrackingUrl(source);
    if (url) return url;
  }
  for (const source of sources) {
    const code = trackingCode(source);
    if (code) return fleetbaseConsoleUrl(`~/track/${encodeURIComponent(code)}`);
  }
  return null;
}

async function createFleetbaseOrder(transaction: any): Promise<FleetbaseOrder> {
  const apiKey = process.env.FLEETBASE_API_KEY;
  if (!apiKey) throw new FulfilmentError(503, 'Fleetbase is not configured. Set FLEETBASE_API_KEY before approving a delivery.');
  const apiUrl = process.env.FLEETBASE_ORDERS_URL || 'https://api.fleetbase.io/v1/orders';
  const finalDestination = transaction.destination;
  if (!finalDestination?.address || !Number.isFinite(Number(finalDestination.latitude)) ||
      !Number.isFinite(Number(finalDestination.longitude))) {
    throw new FulfilmentError(409, 'The buyer delivery location is incomplete.');
  }
  const handoverLocation = {
    name: TRUSTEA_COLLECTION_POINT.name,
    address: TRUSTEA_COLLECTION_POINT.address,
    latitude: TRUSTEA_COLLECTION_POINT.latitude,
    longitude: TRUSTEA_COLLECTION_POINT.longitude
  };

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'Idempotency-Key': transaction.id
    },
    body: JSON.stringify({
      reference: transaction.id,
      external_id: transaction.id,
      payload: {
        pickup: {
          name: handoverLocation.name,
          phone: TRUSTEA_COLLECTION_POINT.phone,
          address: handoverLocation.address,
          location: {
            latitude: handoverLocation.latitude,
            longitude: handoverLocation.longitude
          }
        },
        dropoff: {
          name: transaction.buyer_name,
          phone: transaction.buyer_phone,
          address: finalDestination.address,
          location: {
            latitude: Number(finalDestination.latitude),
            longitude: Number(finalDestination.longitude)
          }
        },
        entities: [{
          description: transaction.item_description,
          quantity: 1,
          value: Number(transaction.item_value),
          currency: 'ZMW'
        }],
        instructions: 'The seller will bring the parcel to the Lusaka collection point at 35 NALIKWANDA ROAD. Fleetbase manages delivery from that collection point directly to the buyer dropoff for all distances. Do not create or dispatch Shipday jobs.',
        metadata: {
          trustea_transaction_id: transaction.id,
          trustea_fulfilment_provider: 'fleetbase',
          payment_method: transaction.payment_method || 'salary_deduction',
          payment_status: transaction.payment_status || 'authorized',
          handover_location: handoverLocation,
          buyer: {
            name: transaction.buyer_name,
            phone: transaction.buyer_phone,
            destination: {
              address: finalDestination.address,
              latitude: Number(finalDestination.latitude),
              longitude: Number(finalDestination.longitude)
            }
          }
        }
      },
      metadata: {
        trustea_transaction_id: transaction.id,
        trustea_fulfilment_provider: 'fleetbase',
        payment_method: transaction.payment_method || 'salary_deduction',
        payment_status: transaction.payment_status || 'authorized',
        handover_location: handoverLocation
      }
    })
  });
  const result = await response.json().catch(() => null) as Record<string, any> | null;
  if (!response.ok || result?.success === false || result?.errors?.length) {
    console.error('[Fulfilment] Fleetbase order creation failed:', response.status, result);
    throw new FulfilmentError(502, 'Fleetbase could not accept this delivery. No delivery was marked as booked.');
  }
  const order = result?.data?.attributes || result?.data || result?.order || result;
  const orderId = order?.id ?? result?.data?.id ?? order?.uuid ?? order?.public_id;
  if (orderId === undefined || orderId === null) {
    console.error('[Fulfilment] Fleetbase response did not contain an order ID:', result);
    throw new FulfilmentError(502, 'Fleetbase returned no order ID. The delivery was not marked as booked.');
  }
  const trackingUrl = resolveFleetbaseTrackingUrl(order, result);
  return {
    orderId: String(orderId),
    status: String(order.status || 'created'),
    trackingUrl: trackingUrl ? String(trackingUrl) : null
  };
}

async function createShopFleetbaseOrder(
  order: any,
  authorization: any,
  product: any,
  creator: any,
  pickup: any,
  delivery: any
): Promise<FleetbaseOrder> {
  const apiKey = process.env.FLEETBASE_API_KEY;
  if (!apiKey) throw new FulfilmentError(503, 'Fleetbase is not configured. Set FLEETBASE_API_KEY before approving a shop order.');
  if (!pickup?.pickup_address || !pickup?.pickup_phone ||
      !Number.isFinite(Number(pickup.pickup_latitude)) || !Number.isFinite(Number(pickup.pickup_longitude))) {
    throw new FulfilmentError(409, 'The creator pickup details are incomplete.');
  }
  if (!delivery?.delivery_address || !delivery?.recipient_phone ||
      !Number.isFinite(Number(delivery.delivery_latitude)) || !Number.isFinite(Number(delivery.delivery_longitude))) {
    throw new FulfilmentError(409, 'The buyer delivery details are incomplete.');
  }

  const response = await fetch(process.env.FLEETBASE_ORDERS_URL || 'https://api.fleetbase.io/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'Idempotency-Key': `sumthin-shop-${order.id}`
    },
    body: JSON.stringify({
      reference: order.id,
      external_id: order.id,
      payload: {
        pickup: {
          name: pickup.pickup_name || creator.display_name,
          phone: pickup.pickup_phone,
          address: pickup.pickup_address,
          location: {
            latitude: Number(pickup.pickup_latitude),
            longitude: Number(pickup.pickup_longitude)
          }
        },
        dropoff: {
          name: delivery.recipient_name,
          phone: delivery.recipient_phone,
          address: delivery.delivery_address,
          location: {
            latitude: Number(delivery.delivery_latitude),
            longitude: Number(delivery.delivery_longitude)
          }
        },
        entities: [{
          description: product.name,
          quantity: Number(order.quantity),
          value: Number(authorization.amount),
          currency: 'ZMW'
        }],
        instructions: 'Fleetbase manages the complete delivery from the creator pickup directly to the buyer dropoff for all distances. Do not create or dispatch Shipday jobs.',
        metadata: {
          sumthin_creator_order_id: order.id,
          sumthin_fulfilment_provider: 'fleetbase',
          salary_payment_authorization_id: authorization.id,
          buyer: {
            name: delivery.recipient_name,
            phone: delivery.recipient_phone,
            destination: {
              address: delivery.delivery_address,
              latitude: Number(delivery.delivery_latitude),
              longitude: Number(delivery.delivery_longitude)
            }
          },
          seller: {
            name: creator.display_name,
            phone: pickup.pickup_phone,
            pickup: {
              address: pickup.pickup_address,
              latitude: Number(pickup.pickup_latitude),
              longitude: Number(pickup.pickup_longitude)
            }
          }
        }
      },
      metadata: {
        sumthin_creator_order_id: order.id,
        salary_payment_authorization_id: authorization.id,
        sumthin_order_type: 'creator_shop',
        sumthin_fulfilment_provider: 'fleetbase'
      }
    })
  });
  const result = await response.json().catch(() => null) as Record<string, any> | null;
  if (!response.ok || result?.success === false || result?.errors?.length) {
    console.error('[Fulfilment] Fleetbase shop order creation failed:', response.status, result);
    throw new FulfilmentError(502, 'Fleetbase could not accept this shop delivery. No delivery was marked as booked.');
  }
  const remoteOrder = result?.data?.attributes || result?.data || result?.order || result;
  const orderId = remoteOrder?.id ?? result?.data?.id ?? remoteOrder?.uuid ?? remoteOrder?.public_id;
  if (orderId === undefined || orderId === null) {
    console.error('[Fulfilment] Fleetbase shop response did not contain an order ID:', result);
    throw new FulfilmentError(502, 'Fleetbase returned no order ID. The shop delivery was not marked as booked.');
  }
  const trackingUrl = resolveFleetbaseTrackingUrl(remoteOrder, result);
  return {
    orderId: String(orderId),
    status: String(remoteOrder.status || 'created'),
    trackingUrl: trackingUrl ? String(trackingUrl) : null
  };
}

function fleetbaseTransactionStatus(stage: string, currentStatus: string): string | null {
  const normalized = stage.toLowerCase().replace(/[\s.-]+/g, '_');
  const statuses: Record<string, string> = {
    order_created: 'delivery_pending',
    order_dispatched: 'delivery_pending',
    created: 'delivery_pending',
    dispatched: 'delivery_pending',
    pickup_created: 'delivery_pending',
    order_started: 'in_transit',
    started: 'in_transit',
    in_transit: 'in_transit',
    en_route: 'in_transit',
    pickup_started: 'in_transit',
    picked_up: 'in_transit',
    rider_picked_up: 'in_transit',
    first_mile: 'in_transit',
    order_completed: 'delivered',
    completed: 'delivered',
    handover: 'in_transit',
    hub_received: 'in_transit',
    at_fleetbase_location: 'at_fleetbase_location',
    aggregation: 'fleetbase_aggregation',
    aggregating: 'fleetbase_aggregation',
    fleetbase_aggregation: 'fleetbase_aggregation',
    hub_sorting: 'fleetbase_aggregation',
    middle_mile: 'fleetbase_middle_mile',
    fleetbase_middle_mile: 'fleetbase_middle_mile',
    middle_mile_in_transit: 'fleetbase_middle_mile',
    final_delivery: 'final_delivery',
    last_mile: 'final_delivery',
    out_for_delivery: 'final_delivery',
    delivered: 'delivered',
    final_delivery_completed: 'delivered',
    recipient_handover: 'delivered',
    order_canceled: 'delivery_exception',
    canceled: 'delivery_exception',
    cancelled: 'delivery_exception',
    failed: 'delivery_exception',
    delivery_exception: 'delivery_exception'
  };
  const nextStatus = statuses[normalized];
  if (!nextStatus) return null;

  const progression = ['delivery_pending', 'in_transit', 'at_fleetbase_location', 'fleetbase_aggregation', 'fleetbase_middle_mile', 'final_delivery', 'delivered'];
  const currentIndex = progression.indexOf(currentStatus);
  const nextIndex = progression.indexOf(nextStatus);
  if (currentStatus === 'return_window' || currentStatus === 'return_requested' ||
      currentStatus === 'settlement_due' || currentStatus === 'completed' ||
      currentStatus === 'returned' || currentStatus === 'cancelled') return currentStatus;
  if (nextStatus === 'delivery_exception') return nextStatus;
  return currentIndex > nextIndex ? currentStatus : nextStatus;
}

async function participantSms(transaction: any, buyerMessage: string, sellerMessage: string, smsType: string): Promise<void> {
  const buyerUrl = participantUrl(transaction.id, decryptToken(transaction.buyer_token_ciphertext));
  const sellerUrl = participantUrl(transaction.id, decryptToken(transaction.seller_token_ciphertext));
  await Promise.all([
    queueSms(transaction.buyer_phone, `${buyerMessage} ${buyerUrl}`, transaction.id, smsType),
    queueSms(transaction.seller_phone, `${sellerMessage} ${sellerUrl}`, transaction.id, smsType)
  ]);
}

async function requireMfiOperator(req: Request): Promise<{ id: string }> {
  const authorization = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) throw new FulfilmentError(401, 'Sign in with an MFI operator account.');
  const { data, error } = await db().auth.getUser(match[1]);
  if (error || !data.user || data.user.app_metadata?.role !== 'mfi_operator') {
    throw new FulfilmentError(403, 'Only an authorized MFI operator can access fulfilment loans.');
  }
  return { id: data.user.id };
}

async function requirePhoneMfa(req: Request, factorIdValue: unknown): Promise<{ id: string; phone: string }> {
  const user = await authenticateTrusteaUser(req);
  if (user.claims?.aal !== 'aal2') {
    throw new FulfilmentError(403, 'Verify your phone with its SMS code before using the BuySafe inbox.');
  }
  const methods = Array.isArray(user.claims.amr) ? user.claims.amr : [];
  const latestMethod = methods.length ? methods[methods.length - 1] : null;
  const method = typeof latestMethod === 'string'
    ? latestMethod
    : latestMethod && typeof latestMethod === 'object' && 'method' in latestMethod &&
      typeof latestMethod.method === 'string' ? latestMethod.method : '';
  if (!['otp', 'phone', 'sms'].includes(method)) {
    throw new FulfilmentError(403, 'Verify your phone with its SMS code before using the BuySafe inbox.');
  }

  const factorId = requireText(factorIdValue, 'verified phone factor', 80);
  const { data: phoneFactor, error: phoneFactorError } = await db().from('fulfilment_mfa_phone_factors')
    .select('factor_id, phone')
    .eq('user_id', user.id)
    .maybeSingle();
  if (phoneFactorError) {
    console.error('[Fulfilment] Could not load BuySafe phone factor:', phoneFactorError.message);
    throw new FulfilmentError(502, 'Could not verify your BuySafe phone factor.');
  }
  if (!phoneFactor || phoneFactor.factor_id !== factorId) {
    throw new FulfilmentError(403, 'Use the phone factor registered for your BuySafe account.');
  }
  const { data: factorData, error: factorError } = await db().auth.admin.mfa.listFactors({ userId: user.id });
  if (factorError) {
    console.error('[Fulfilment] Could not verify phone factor:', factorError.message);
    throw new FulfilmentError(502, 'Could not verify your BuySafe phone factor.');
  }
  const factor = factorData.factors.find((item) =>
    item.id === factorId && item.factor_type === 'phone' && item.status === 'verified');
  if (!factor) {
    throw new FulfilmentError(403, 'Verify a phone SMS factor before using the BuySafe inbox.');
  }

  return { id: user.id, phone: normalizePhone(phoneFactor.phone, 'verified phone number') };
}

export function createFulfilmentRouter(io: SocketIOServer): Router {
  const router = Router();

  router.get('/config', route(async (_req, res) => {
    res.json({
      insurance_rate_pct: Number(process.env.FULFILMENT_INSURANCE_RATE_PCT || 2),
      return_window_hours: 24,
      fleetbase_configured: Boolean(process.env.FLEETBASE_API_KEY)
    });
  }));

  router.get('/locations', route(async (_req, res) => {
    const { data, error } = await db().from('fulfilment_locations')
      .select('id, label, address')
      .eq('active', true)
      .order('label');
    if (error) throw new FulfilmentError(502, 'Could not load saved locations.');
    res.json(data || []);
  }));

  router.get('/phone-factor', route(async (req, res) => {
    const user = await authenticateTrusteaUser(req);
    const { data: savedFactor, error: savedFactorError } = await db().from('fulfilment_mfa_phone_factors')
      .select('factor_id, phone')
      .eq('user_id', user.id)
      .maybeSingle();
    if (savedFactorError) {
      console.error('[Fulfilment] Could not load BuySafe phone setup:', savedFactorError.message);
      throw new FulfilmentError(502, 'Could not load your BuySafe phone setup.');
    }
    if (!savedFactor) {
      res.json(null);
      return;
    }
    const { data: factors, error: factorsError } = await db().auth.admin.mfa.listFactors({ userId: user.id });
    if (factorsError) {
      console.error('[Fulfilment] Could not check BuySafe phone setup:', factorsError.message);
      throw new FulfilmentError(502, 'Could not check your BuySafe phone setup.');
    }
    if (!factors.factors.some((factor) => factor.id === savedFactor.factor_id && factor.factor_type === 'phone')) {
      const { error: deleteError } = await db().from('fulfilment_mfa_phone_factors').delete().eq('user_id', user.id);
      if (deleteError) {
        console.error('[Fulfilment] Could not remove stale BuySafe phone setup:', deleteError.message);
        throw new FulfilmentError(502, 'Your old BuySafe phone setup could not be cleared.');
      }
      res.json(null);
      return;
    }
    res.json({ factor_id: savedFactor.factor_id, phone: savedFactor.phone });
  }));

  router.post('/phone-factor', route(async (req, res) => {
    const user = await authenticateTrusteaUser(req);
    const phone = normalizePhone(req.body.phone, 'phone number');
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      throw new FulfilmentError(400, 'Enter the phone in international format, for example +260XXXXXXXXX.');
    }
    if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY === '******') {
      throw new FulfilmentError(503, 'Set SUPABASE_ANON_KEY on the hub to enroll a BuySafe phone factor.');
    }
    const { data: existingFactor, error: existingFactorError } = await db().from('fulfilment_mfa_phone_factors')
      .select('factor_id, phone')
      .eq('user_id', user.id)
      .maybeSingle();
    if (existingFactorError) {
      console.error('[Fulfilment] Could not check existing BuySafe phone factor:', existingFactorError.message);
      throw new FulfilmentError(502, 'Could not check your BuySafe phone setup.');
    }
    if (existingFactor) {
      res.json({ factor_id: existingFactor.factor_id, phone: existingFactor.phone });
      return;
    }

    const response = await fetch(`${SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/factors`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${user.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ factor_type: 'phone', phone, friendly_name: 'BuySafe SMS verification' }),
    });
    const result: unknown = await response.json().catch(() => null);
    const returnedFactorId = result && typeof result === 'object' && 'id' in result ? result.id : null;
    if (!response.ok) {
      const reason = result && typeof result === 'object' && 'msg' in result && typeof result.msg === 'string'
        ? result.msg
        : 'Could not enroll your BuySafe phone factor.';
      throw new FulfilmentError(response.status >= 400 && response.status < 500 ? response.status : 502, reason);
    }
    if (typeof returnedFactorId !== 'string' || !/^[0-9a-f-]{36}$/i.test(returnedFactorId)) {
      throw new FulfilmentError(502, 'Supabase returned an invalid BuySafe phone factor.');
    }
    const { error: saveError } = await db().from('fulfilment_mfa_phone_factors').insert({
      user_id: user.id,
      factor_id: returnedFactorId,
      phone,
    });
    if (saveError) {
      console.error('[Fulfilment] Could not save BuySafe phone factor:', saveError.message);
      const { error: cleanupError } = await db().auth.admin.mfa.deleteFactor({
        id: returnedFactorId,
        userId: user.id,
      });
      if (cleanupError) {
        console.error('[Fulfilment] Could not remove unlinked BuySafe phone factor:', cleanupError.message);
      }
      throw new FulfilmentError(502, 'The phone factor was created but could not be linked to your BuySafe account.');
    }
    res.status(201).json({ factor_id: returnedFactorId, phone });
  }));

  router.get('/transactions/inbox', route(async (req, res) => {
    const participant = await requirePhoneMfa(req, req.query.factor_id);
    const { data, error } = await db().from('fulfilment_transactions')
      .select('id, buyer_user_id, seller_user_id, buyer_token_ciphertext, seller_token_ciphertext')
      .or(`buyer_user_id.eq.${participant.id},seller_user_id.eq.${participant.id}`)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) {
      console.error('[Fulfilment] Could not load BuySafe inbox:', error.message);
      throw new FulfilmentError(502, 'Could not load your BuySafe inbox.');
    }
    res.json((data || []).map((transaction) => {
      const role: Role = transaction.buyer_user_id === participant.id ? 'buyer' : 'seller';
      const encryptedToken = role === 'buyer'
        ? transaction.buyer_token_ciphertext
        : transaction.seller_token_ciphertext;
      return { id: transaction.id, token: decryptToken(encryptedToken), role };
    }));
  }));

  router.post('/transactions', route(async (req, res) => {
    const participant = await requirePhoneMfa(req, req.body.phone_factor_id);
    const buyerName = requireText(req.body.buyer_name, 'buyer name', 100);
    const sellerPhone = normalizePhone(req.body.seller_phone, 'seller phone number');
    const id = uuidv4();
    const buyerToken = randomBytes(32).toString('base64url');
    const sellerToken = randomBytes(32).toString('base64url');
    const insuranceRate = Number(process.env.FULFILMENT_INSURANCE_RATE_PCT || 2);
    if (!Number.isFinite(insuranceRate) || insuranceRate < 0 || insuranceRate > 100) {
      throw new FulfilmentError(503, 'The configured insurance rate is invalid.');
    }

    const record = {
      id,
      buyer_token_hash: tokenHash(buyerToken),
      seller_token_hash: tokenHash(sellerToken),
      buyer_token_ciphertext: encryptToken(buyerToken),
      seller_token_ciphertext: encryptToken(sellerToken),
      buyer_name: buyerName,
      buyer_phone: participant.phone,
      seller_phone: sellerPhone,
      buyer_user_id: participant.id,
      insurance_rate_pct: insuranceRate,
      status: 'seller_response_pending'
    };
    const { data, error } = await db().from('fulfilment_transactions').insert(record).select('*').single();
    if (error) {
      console.error('[Fulfilment] Could not create transaction:', error.message);
      throw new FulfilmentError(502, 'Could not create the transaction.');
    }
    await addEvent(id, 'created', 'The buyer started a private transaction and invited the seller.');
    const sellerUrl = participantUrl(id, sellerToken);
    try {
      await queueSms(sellerPhone, `A buyer has invited you to complete a Trustea transaction. Add the item details and pickup location here: ${sellerUrl}`, id, 'seller_invitation');
    } catch (error) {
      await db().from('fulfilment_transactions').delete().eq('id', id);
      throw error;
    }
    res.status(201).json({
      transaction_id: data.id,
      buyer_url: participantUrl(id, buyerToken),
      status: data.status
    });
  }));

  router.post('/transactions/:id/link', route(async (req, res) => {
    const participant = await requirePhoneMfa(req, req.body.phone_factor_id);
    const id = requireText(req.params.id, 'transaction link', 80);
    const suppliedToken = requireText(req.body.token, 'private transaction link', 200);
    const transaction = await loadTransaction(id);
    const hash = tokenHash(suppliedToken);
    const role: Role | null = equalHash(hash, transaction.buyer_token_hash)
      ? 'buyer'
      : equalHash(hash, transaction.seller_token_hash) ? 'seller' : null;
    if (!role) throw new FulfilmentError(403, 'This private transaction link is invalid.');

    const participantPhone = role === 'buyer' ? transaction.buyer_phone : transaction.seller_phone;
    if (participant.phone !== normalizePhone(participantPhone, 'transaction phone number')) {
      throw new FulfilmentError(403, 'Your verified SMS factor does not match this transaction phone number.');
    }
    const userIdColumn = role === 'buyer' ? 'buyer_user_id' : 'seller_user_id';
    const linkedUserId = role === 'buyer' ? transaction.buyer_user_id : transaction.seller_user_id;
    if (linkedUserId && linkedUserId !== participant.id) {
      throw new FulfilmentError(409, 'This transaction is already linked to another Trustea account.');
    }
    const { error } = await db().from('fulfilment_transactions')
      .update({ [userIdColumn]: participant.id })
      .eq('id', id);
    if (error) {
      console.error('[Fulfilment] Could not link transaction to account:', error.message);
      throw new FulfilmentError(502, 'Could not save this transaction to your BuySafe inbox.');
    }
    res.json({ success: true, role });
  }));

  router.get('/transactions/:id', route(async (req, res) => {
    const { transaction: loaded, role } = await authorizeParticipant(req);
    const transaction = await checkReturnWindow(loaded);
    res.json(await transactionView(transaction, role));
  }));

  router.post('/transactions/:id/seller-response', route(async (req, res) => {
    const { transaction, role } = await authorizeParticipant(req);
    if (role !== 'seller') throw new FulfilmentError(403, 'Only the seller can add item details.');
    if (transaction.status !== 'seller_response_pending') throw new FulfilmentError(409, 'The seller response has already been submitted.');
    const sellerName = requireText(req.body.seller_name, 'seller name', 100);
    const description = requireText(req.body.description, 'item description', 500);
    const itemValue = Number(req.body.item_value);
    if (!Number.isFinite(itemValue) || itemValue <= 0 || itemValue > 1000000) {
      throw new FulfilmentError(400, 'Enter a valid item value in ZMW.');
    }
    const origin = await resolveLocation(req.body.origin as LocationInput);
    const photos = Array.isArray(req.body.photos) ? req.body.photos : [];
    if (photos.length > 4) throw new FulfilmentError(400, 'Add no more than four item photos.');

    const photoPaths: string[] = [];
    let totalPhotoBytes = 0;
    for (const photo of photos) {
      if (typeof photo !== 'string') throw new FulfilmentError(400, 'Each item photo must be an image.');
      const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(photo);
      if (!match) throw new FulfilmentError(400, 'Use JPG, PNG, or WebP item photos.');
      const buffer = Buffer.from(match[2], 'base64');
      totalPhotoBytes += buffer.length;
      if (buffer.length > 2 * 1024 * 1024 || totalPhotoBytes > 6 * 1024 * 1024) {
        throw new FulfilmentError(413, 'Item photos must be at most 2 MB each and 6 MB in total.');
      }
      const path = `${transaction.id}/${uuidv4()}.${match[1]}`;
      const { error } = await db().storage.from('fulfilment-photos').upload(path, buffer, {
        contentType: `image/${match[1]}`,
        upsert: false
      });
      if (error) {
        console.error('[Fulfilment] Photo upload failed:', error.message);
        throw new FulfilmentError(502, 'Could not securely upload an item photo.');
      }
      photoPaths.push(path);
    }

    const insurance = Math.round(itemValue * Number(transaction.insurance_rate_pct) * 100) / 10000;
    const { data, error } = await db().from('fulfilment_transactions').update({
      seller_name: sellerName,
      item_description: description,
      item_value: itemValue,
      insurance_amount: insurance,
      origin,
      photo_paths: photoPaths,
      status: 'buyer_checkout_pending',
      updated_at: new Date().toISOString()
    }).eq('id', transaction.id).eq('status', 'seller_response_pending').select('*').maybeSingle();
    if (error) throw new FulfilmentError(502, 'Could not save the seller response.');
    if (!data) throw new FulfilmentError(409, 'The transaction has already changed.');
    await addEvent(transaction.id, 'seller_responded', 'The seller added item details, declared value, photos, and pickup location.');
    const buyerUrl = participantUrl(data.id, decryptToken(data.buyer_token_ciphertext));
    await queueSms(data.buyer_phone, `The seller has responded to your Trustea transaction. Review the item and add your delivery location: ${buyerUrl}`, data.id, 'seller_responded');
    io.to(`fulfilment:${data.id}`).emit('fulfilment:updated', { transaction_id: data.id });
    res.json({ success: true, insurance_amount: insurance, transaction: await transactionView(data, role) });
  }));

  router.post('/transactions/:id/checkout', route(async (req, res) => {
    const { transaction, role } = await authorizeParticipant(req);
    if (role !== 'buyer') throw new FulfilmentError(403, 'Only the buyer can choose delivery and payment.');
    if (transaction.status !== 'buyer_checkout_pending') throw new FulfilmentError(409, 'This transaction is not waiting for buyer checkout.');
    if (req.body.salary_deduction_consent !== true) throw new FulfilmentError(400, 'Explicit salary-deduction consent is required.');
    const destination = await resolveLocation(req.body.destination as LocationInput);
    const amount = Number(req.body.salary_deduction_amount);
    const total = Number(transaction.item_value) + Number(transaction.insurance_amount);
    if (!Number.isFinite(amount) || Math.round(amount * 100) !== Math.round(total * 100)) {
      throw new FulfilmentError(400, `The salary-deduction amount must match the confirmed total of ZMW ${total.toFixed(2)}.`);
    }

    const now = new Date().toISOString();
    const { data: updated, error } = await db().from('fulfilment_transactions').update({
      destination,
      salary_deduction_amount: amount,
      salary_deduction_consent_at: now,
      payment_method: 'salary_deduction',
      payment_status: 'pending_mfi',
      status: 'mfi_review',
      updated_at: now
    }).eq('id', transaction.id).eq('status', 'buyer_checkout_pending').select('*').maybeSingle();
    if (error) throw new FulfilmentError(502, 'Could not save the buyer checkout.');
    if (!updated) throw new FulfilmentError(409, 'The transaction has already changed.');

    const { error: loanError } = await db().from('fulfilment_loan_requests').insert({
      transaction_id: transaction.id,
      borrower_name: transaction.buyer_name,
      borrower_phone: transaction.buyer_phone,
      amount,
      consent_at: now
    });
    if (loanError) {
      await db().from('fulfilment_transactions').update({
        status: 'buyer_checkout_pending',
        destination: null,
        salary_deduction_amount: null,
        salary_deduction_consent_at: null,
        updated_at: new Date().toISOString()
      }).eq('id', transaction.id).eq('status', 'mfi_review');
      console.error('[Fulfilment] Could not create MFI loan request:', loanError.message);
      throw new FulfilmentError(502, 'Could not submit the salary-deduction request to the MFI.');
    }
    await addEvent(transaction.id, 'mfi_review', 'The buyer confirmed the delivery location and consented to salary deduction. The request is awaiting MFI review.');
    await queueSms(transaction.buyer_phone, `Your salary-deduction request for Trustea transaction ${transaction.id.slice(0, 8)} is with the MFI for review. We will message you when it is approved. ${participantUrl(transaction.id, decryptToken(transaction.buyer_token_ciphertext))}`, transaction.id, 'mfi_review');
    io.to(`fulfilment:${transaction.id}`).emit('fulfilment:updated', { transaction_id: transaction.id });
    res.json({ success: true, status: 'mfi_review' });
  }));

  router.post('/transactions/:id/receipt', route(async (req, res) => {
    const { transaction, role } = await authorizeParticipant(req);
    if (role !== 'buyer') throw new FulfilmentError(403, 'Only the buyer can confirm receipt.');
    if (transaction.status !== 'delivered') throw new FulfilmentError(409, 'Receipt can be confirmed after Fleetbase marks the parcel delivered.');
    const now = new Date();
    const ends = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const { data, error } = await db().from('fulfilment_transactions').update({
      status: 'return_window',
      parcel_received_at: now.toISOString(),
      return_window_ends_at: ends.toISOString(),
      updated_at: now.toISOString()
    }).eq('id', transaction.id).eq('status', 'delivered').select('*').maybeSingle();
    if (error) throw new FulfilmentError(502, 'Could not confirm parcel receipt.');
    if (!data) throw new FulfilmentError(409, 'The transaction has already changed.');
    await addEvent(transaction.id, 'parcel_received', 'The buyer confirmed receipt. The 24-hour return window has started.');
    await participantSms(
      data,
      `The buyer confirmed receipt of transaction ${data.id.slice(0, 8)}. The 24-hour return window ends ${ends.toLocaleString('en-GB', { timeZone: 'UTC' })} UTC.`,
      `The buyer confirmed receipt of transaction ${data.id.slice(0, 8)}. The 24-hour return window ends ${ends.toLocaleString('en-GB', { timeZone: 'UTC' })} UTC.`,
      'parcel_received'
    );
    io.to(`fulfilment:${data.id}`).emit('fulfilment:updated', { transaction_id: data.id });
    res.json({ success: true, status: data.status, return_window_ends_at: data.return_window_ends_at });
  }));

  router.post('/transactions/:id/return', route(async (req, res) => {
    const { transaction, role } = await authorizeParticipant(req);
    if (role !== 'buyer') throw new FulfilmentError(403, 'Only the buyer can request a return.');
    if (transaction.status !== 'return_window' || new Date(transaction.return_window_ends_at).getTime() <= Date.now()) {
      throw new FulfilmentError(409, 'The return window is no longer open.');
    }
    const { data, error } = await db().from('fulfilment_transactions').update({
      status: 'return_requested',
      updated_at: new Date().toISOString()
    }).eq('id', transaction.id).eq('status', 'return_window').select('*').maybeSingle();
    if (error) throw new FulfilmentError(502, 'Could not submit the return request.');
    if (!data) throw new FulfilmentError(409, 'The transaction has already changed.');
    await addEvent(transaction.id, 'return_requested', 'The buyer requested a return. Settlement is paused pending MFI review.');
    await participantSms(data, `The buyer requested a return for transaction ${data.id.slice(0, 8)}. Settlement is paused while the MFI reviews it.`, `A return was requested for transaction ${data.id.slice(0, 8)}. Settlement is paused while the MFI reviews it.`, 'return_requested');
    io.to(`fulfilment:${data.id}`).emit('fulfilment:updated', { transaction_id: data.id });
    res.json({ success: true, status: data.status });
  }));

  router.get('/mfi/loans', route(async (req, res) => {
    await requireMfiOperator(req);
    const { data: expiredWindows, error: expiryError } = await db().from('fulfilment_transactions')
      .select('*')
      .eq('status', 'return_window')
      .lte('return_window_ends_at', new Date().toISOString());
    if (expiryError) throw new FulfilmentError(502, 'Could not check fulfilment return windows.');
    for (const transaction of expiredWindows || []) await checkReturnWindow(transaction);

    const { data: loans, error } = await db().from('fulfilment_loan_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new FulfilmentError(502, 'Could not load fulfilment loan requests.');
    const ids = (loans || []).map(loan => loan.transaction_id);
    const { data: transactions, error: transactionError } = ids.length
      ? await db().from('fulfilment_transactions')
        .select('id, status, seller_name, item_description, item_value, insurance_amount, return_window_ends_at, fleetbase_order_id, fleetbase_status, fleetbase_tracking_url')
        .in('id', ids)
      : { data: [], error: null };
    if (transactionError) throw new FulfilmentError(502, 'Could not load the related transactions.');
    const byId = new Map((transactions || []).map(transaction => [transaction.id, transaction]));
    res.json((loans || []).flatMap(loan => {
      const transaction = byId.get(loan.transaction_id);
      return transaction ? [{ ...loan, transaction }] : [];
    }));
  }));

  router.get('/mfi/shop-orders', route(async (req, res) => {
    await requireMfiOperator(req);
    const { data: authorizations, error: authorizationError } = await db().from('salary_payment_authorizations')
      .select('id, user_id, salary_application_id, amount, quantity, status, created_at')
      .eq('payment_type', 'shop_order')
      .order('created_at', { ascending: false })
      .limit(200);
    if (authorizationError) throw new FulfilmentError(502, 'Could not load Sumthin shop payments.');
    const authorizationIds = (authorizations || []).map(item => item.id);
    const { data: orders, error: orderError } = authorizationIds.length
      ? await db().from('creator_orders').select('*').in('payment_authorization_id', authorizationIds)
      : { data: [], error: null };
    if (orderError) throw new FulfilmentError(502, 'Could not load Sumthin shop orders.');
    const orderRows = orders || [];
    const productIds = [...new Set(orderRows.map(item => item.product_id))];
    const creatorIds = [...new Set(orderRows.map(item => item.creator_id))];
    const applicationIds = [...new Set((authorizations || []).map(item => item.salary_application_id))];
    const [productResult, creatorResult, pickupResult, deliveryResult, applicationResult, returnResult] = await Promise.all([
      productIds.length
        ? db().from('creator_products').select('id, name, description, creator_id').in('id', productIds)
        : Promise.resolve({ data: [], error: null }),
      creatorIds.length
        ? db().from('creator_profiles').select('id, display_name').in('id', creatorIds)
        : Promise.resolve({ data: [], error: null }),
      creatorIds.length
        ? db().from('creator_fulfilment_profiles').select('creator_id, pickup_name, pickup_phone, pickup_address').in('creator_id', creatorIds)
        : Promise.resolve({ data: [], error: null }),
      orderRows.length
        ? db().from('creator_order_deliveries').select('*').in('order_id', orderRows.map(item => item.id))
        : Promise.resolve({ data: [], error: null }),
      applicationIds.length
        ? db().from('salary_applications').select('id, applicant_first_name, applicant_last_name, employment_number').in('id', applicationIds)
        : Promise.resolve({ data: [], error: null }),
      orderRows.length
        ? db().from('creator_order_returns').select('id, order_id, reason, status, requested_at, review_note').in('order_id', orderRows.map(item => item.id))
        : Promise.resolve({ data: [], error: null })
    ]);
    const referenceError = productResult.error || creatorResult.error || pickupResult.error || deliveryResult.error || applicationResult.error || returnResult.error;
    if (referenceError) throw new FulfilmentError(502, 'Could not load shop-order details.');
    const authorizationById = new Map((authorizations || []).map(item => [item.id, item]));
    const productById = new Map((productResult.data || []).map(item => [item.id, item]));
    const creatorById = new Map((creatorResult.data || []).map(item => [item.id, item]));
    const pickupByCreatorId = new Map((pickupResult.data || []).map(item => [item.creator_id, item]));
    const deliveryByOrderId = new Map((deliveryResult.data || []).map(item => [item.order_id, item]));
    const applicationById = new Map((applicationResult.data || []).map(item => [item.id, item]));
    const returnByOrderId = new Map((returnResult.data || []).map(item => [item.order_id, item]));
    res.json(orderRows.map(order => {
      const authorization = authorizationById.get(order.payment_authorization_id);
      const application = authorization ? applicationById.get(authorization.salary_application_id) : null;
      return {
        ...order,
        authorization,
        product: productById.get(order.product_id) || null,
        creator: creatorById.get(order.creator_id) || null,
        pickup: pickupByCreatorId.get(order.creator_id) || null,
        delivery_name: deliveryByOrderId.get(order.id)?.recipient_name || null,
        delivery_phone: deliveryByOrderId.get(order.id)?.recipient_phone || null,
        delivery_address: deliveryByOrderId.get(order.id)?.delivery_address || null,
        return_request: returnByOrderId.get(order.id) || null,
        customer: application ? {
          name: `${application.applicant_first_name} ${application.applicant_last_name}`,
          employment_number: application.employment_number
        } : null
      };
    }));
  }));

  router.post('/mfi/shop-orders/:id/approve', route(async (req, res) => {
    const operator = await requireMfiOperator(req);
    const { data: order, error: orderError } = await db().from('creator_orders')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (orderError) throw new FulfilmentError(502, 'Could not load the shop order.');
    if (!order) throw new FulfilmentError(404, 'Shop order not found.');
    if (!order.payment_authorization_id) {
      throw new FulfilmentError(409, 'This shop order has no authorized customer payment.');
    }
    const { data: authorization, error: authorizationError } = await db().from('salary_payment_authorizations')
      .select('id, salary_application_id, amount, quantity, status, payment_type')
      .eq('id', order.payment_authorization_id)
      .maybeSingle();
    if (authorizationError) throw new FulfilmentError(502, 'Could not load the shop payment.');
    if (!authorization || authorization.payment_type !== 'shop_order' || authorization.status !== 'authorized') {
      throw new FulfilmentError(409, 'This shop payment is not available for MFI approval.');
    }

    if (order.mfi_approved_at && order.fleetbase_order_id) {
      res.json({
        success: true,
        order_id: order.fleetbase_order_id,
        status: order.fulfilment_status,
        duplicate: true
      });
      return;
    }
    if (!['requested', 'accepted'].includes(order.status)) {
      throw new FulfilmentError(409, 'This shop order is no longer awaiting MFI fulfilment approval.');
    }

    const [{ data: product, error: productError }, { data: creator, error: creatorError }, { data: pickup, error: pickupError }, { data: delivery, error: deliveryError }] = await Promise.all([
      db().from('creator_products').select('id, name, creator_id').eq('id', order.product_id).maybeSingle(),
      db().from('creator_profiles').select('id, display_name').eq('id', order.creator_id).maybeSingle(),
      db().from('creator_fulfilment_profiles').select('*').eq('creator_id', order.creator_id).maybeSingle(),
      db().from('creator_order_deliveries').select('*').eq('order_id', order.id).maybeSingle()
    ]);
    if (productError || creatorError || pickupError || deliveryError) throw new FulfilmentError(502, 'Could not load the shop fulfilment details.');
    if (!product || !creator || !pickup || !delivery) throw new FulfilmentError(409, 'The creator pickup or buyer delivery details are incomplete.');

    const fleetbase = order.fleetbase_order_id
      ? { orderId: order.fleetbase_order_id, status: order.fleetbase_status || 'created', trackingUrl: order.fleetbase_tracking_url || null }
      : await createShopFleetbaseOrder(order, authorization, product, creator, pickup, delivery);
    const { data: updatedOrder, error: updateError } = await db().from('creator_orders')
      .update({
        status: 'accepted',
        mfi_approved_at: order.mfi_approved_at || new Date().toISOString(),
        mfi_approved_by: order.mfi_approved_by || operator.id,
        fulfilment_status: order.fulfilment_status === 'awaiting_mfi' ? 'delivery_pending' : order.fulfilment_status,
        fleetbase_order_id: fleetbase.orderId,
        fleetbase_status: fleetbase.status,
        fleetbase_tracking_url: fleetbase.trackingUrl,
        fleetbase_updated_at: new Date().toISOString()
      })
      .eq('id', order.id)
      .in('status', ['requested', 'accepted'])
      .select('id')
      .maybeSingle();
    if (updateError || !updatedOrder) {
      console.error('[Fulfilment] Fleetbase accepted the Sumthin shop order, but its order ID could not be saved:', fleetbase.orderId, updateError?.message);
      throw new FulfilmentError(502, 'Fleetbase accepted the shop order, but the MFI approval could not be saved. Retry safely or contact support.');
    }
    res.json({ success: true, order_id: fleetbase.orderId, status: 'delivery_pending' });
  }));

  router.post('/mfi/loans/:id/review', route(async (req, res) => {
    const operator = await requireMfiOperator(req);
    const decision = req.body.decision;
    if (decision !== 'approved' && decision !== 'rejected') throw new FulfilmentError(400, 'Choose approve or reject.');
    const { data: loan, error } = await db().from('fulfilment_loan_requests').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw new FulfilmentError(502, 'Could not load the loan request.');
    if (!loan || loan.status !== 'pending_mfi') throw new FulfilmentError(409, 'This MFI request has already been reviewed.');
    const transaction = await loadTransaction(loan.transaction_id);
    if (decision === 'approved') {
      const now = new Date().toISOString();
      let fleetbase: FleetbaseOrder;
      let updated = transaction;
      if (transaction.fleetbase_order_id) {
        fleetbase = {
          orderId: transaction.fleetbase_order_id,
          status: transaction.fleetbase_status || 'created',
          trackingUrl: transaction.fleetbase_tracking_url || null
        };
      } else {
        if (transaction.status !== 'mfi_review') throw new FulfilmentError(409, 'This transaction is no longer awaiting MFI review.');
        fleetbase = await createFleetbaseOrder({
          ...transaction,
          payment_status: transaction.payment_status === 'paid' ? 'paid' : 'authorized'
        });
        const { data: saved, error: updateError } = await db().from('fulfilment_transactions').update({
          status: 'delivery_pending',
          fleetbase_order_id: fleetbase.orderId,
          fleetbase_status: fleetbase.status,
          fleetbase_tracking_url: fleetbase.trackingUrl,
          fleetbase_updated_at: now,
          payment_status: 'authorized',
          updated_at: now
        }).eq('id', transaction.id).eq('status', 'mfi_review').select('*').maybeSingle();
        if (updateError || !saved) {
          console.error('[Fulfilment] Fleetbase accepted the order, but Trustea could not save its order ID:', fleetbase.orderId, updateError?.message);
          throw new FulfilmentError(502, 'Fleetbase accepted the order, but Trustea could not save its order ID. Contact support before retrying.');
        }
        updated = saved;
      }
      const { error: loanUpdateError } = await db().from('fulfilment_loan_requests').update({
        status: 'approved',
        reviewed_at: now,
        reviewed_by: operator.id,
        review_note: typeof req.body.review_note === 'string' ? req.body.review_note.slice(0, 500) : null
      }).eq('id', loan.id).eq('status', 'pending_mfi');
      if (loanUpdateError) throw new FulfilmentError(502, 'Fleetbase accepted the order, but the MFI decision could not be saved. Refresh the request before retrying.');
      await addEvent(transaction.id, 'delivery_booked', `The MFI approved the salary-deduction request. Fleetbase order ${fleetbase.orderId} was created for delivery from the seller directly to the buyer.`);
      await participantSms(
        updated,
        `Your salary-deduction request was approved and Fleetbase is preparing delivery for transaction ${updated.id.slice(0, 8)}. Tracking is available here.`,
        `Your package is approved for delivery. Your payout will be ZMW ${Number(updated.item_value).toFixed(2)} after final delivery and the 24-hour return window. Securely pack transaction ${updated.id.slice(0, 8)} and bring it to COLLECTION POINT, 35 NALIKWANDA ROAD, Lusaka. Contact +260978587417.`,
        'delivery_booked'
      );
      io.to(`fulfilment:${updated.id}`).emit('fulfilment:updated', { transaction_id: updated.id });
      res.json({ success: true, status: 'approved' });
      return;
    }

    const reason = typeof req.body.review_note === 'string' ? req.body.review_note.trim().slice(0, 500) : '';
    const now = new Date().toISOString();
    const { error: loanUpdateError } = await db().from('fulfilment_loan_requests').update({
      status: 'rejected',
      reviewed_at: now,
      reviewed_by: operator.id,
      review_note: reason || null
    }).eq('id', loan.id).eq('status', 'pending_mfi');
    if (loanUpdateError) throw new FulfilmentError(502, 'Could not save the MFI decision.');
    const { data: updated, error: transactionUpdateError } = await db().from('fulfilment_transactions').update({
      status: 'cancelled',
      payment_status: 'rejected',
      updated_at: now
    }).eq('id', transaction.id).eq('status', 'mfi_review').select('*').maybeSingle();
    if (transactionUpdateError || !updated) throw new FulfilmentError(502, 'Could not close the rejected transaction.');
    await addEvent(transaction.id, 'mfi_rejected', `The MFI declined the salary-deduction request${reason ? `: ${reason}` : '.'}`);
    await participantSms(updated, `The MFI declined the salary-deduction request for transaction ${updated.id.slice(0, 8)}. No loan was created.`, `The MFI declined transaction ${updated.id.slice(0, 8)}. No shipment is scheduled.`, 'mfi_rejected');
    io.to(`fulfilment:${updated.id}`).emit('fulfilment:updated', { transaction_id: updated.id });
    res.json({ success: true, status: 'rejected' });
  }));

  router.post('/mfi/loans/:id/return', route(async (req, res) => {
    await requireMfiOperator(req);
    const decision = req.body.decision;
    if (decision !== 'accepted' && decision !== 'declined') throw new FulfilmentError(400, 'Choose accept or decline.');
    const { data: loan, error } = await db().from('fulfilment_loan_requests').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw new FulfilmentError(502, 'Could not load the loan request.');
    if (!loan || loan.status !== 'approved') throw new FulfilmentError(409, 'This return cannot be resolved.');
    const transaction = await loadTransaction(loan.transaction_id);
    if (transaction.status !== 'return_requested') throw new FulfilmentError(409, 'This transaction has no pending return request.');
    const now = new Date().toISOString();
    const status = decision === 'accepted' ? 'returned' : 'return_window';
    const { data, error: updateError } = await db().from('fulfilment_transactions').update({
      status,
      updated_at: now
    }).eq('id', transaction.id).eq('status', 'return_requested').select('*').maybeSingle();
    if (updateError || !data) throw new FulfilmentError(502, 'Could not save the return decision.');
    if (decision === 'accepted') {
      const { error: loanError } = await db().from('fulfilment_loan_requests').update({ status: 'returned' }).eq('id', loan.id);
      if (loanError) throw new FulfilmentError(502, 'Return was recorded, but the MFI loan status could not be updated.');
    }
    await addEvent(transaction.id, decision === 'accepted' ? 'return_accepted' : 'return_declined', decision === 'accepted'
      ? 'The MFI accepted the return. Seller settlement and salary-loan origination were cancelled.'
      : 'The MFI declined the return request. The return window remains active.');
    await participantSms(
      data,
      decision === 'accepted' ? `The MFI accepted your return for transaction ${data.id.slice(0, 8)}. No salary loan will be created.` : `The MFI declined the return for transaction ${data.id.slice(0, 8)}. The return window remains active.`,
      decision === 'accepted' ? `The MFI accepted the return for transaction ${data.id.slice(0, 8)}. No seller settlement or salary loan will be created.` : `The MFI declined the return for transaction ${data.id.slice(0, 8)}. The return window remains active.`,
      decision === 'accepted' ? 'return_accepted' : 'return_declined'
    );
    io.to(`fulfilment:${data.id}`).emit('fulfilment:updated', { transaction_id: data.id });
    res.json({ success: true, status });
  }));

  router.post('/mfi/loans/:id/settle', route(async (req, res) => {
    const operator = await requireMfiOperator(req);
    const { data: loan, error } = await db().from('fulfilment_loan_requests').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw new FulfilmentError(502, 'Could not load the loan request.');
    if (!loan || loan.status !== 'approved') throw new FulfilmentError(409, 'This loan is not ready for settlement.');
    const transaction = await loadTransaction(loan.transaction_id);
    if (transaction.status !== 'settlement_due' ||
        !transaction.return_window_ends_at ||
        new Date(transaction.return_window_ends_at).getTime() > Date.now()) {
      throw new FulfilmentError(409, 'Settlement is available only after the 24-hour return window ends.');
    }

    let payoutReference = typeof req.body.payout_reference === 'string' ? req.body.payout_reference.trim() : '';
    const payoutUrl = process.env.FULFILMENT_SELLER_PAYOUT_URL;
    if (payoutUrl) {
      const response = await fetch(payoutUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.FULFILMENT_SELLER_PAYOUT_KEY
            ? { Authorization: `Bearer ${process.env.FULFILMENT_SELLER_PAYOUT_KEY}` }
            : {})
        },
        body: JSON.stringify({
          transaction_id: transaction.id,
          seller_phone: transaction.seller_phone,
          amount: Number(transaction.item_value),
          currency: 'ZMW'
        })
      });
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok || !payload?.reference) {
        console.error('[Fulfilment] Seller payout failed:', response.status, payload);
        throw new FulfilmentError(502, 'The seller payout provider did not confirm payment. The loan was not originated.');
      }
      payoutReference = String(payload.reference);
    } else if (payoutReference.length < 3 || payoutReference.length > 120) {
      throw new FulfilmentError(400, 'Confirm the seller transfer and enter its payout reference before originating the loan.');
    }

    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await db().from('fulfilment_transactions').update({
      status: 'completed',
      payout_reference: payoutReference,
      payment_status: 'paid',
      paid_at: now,
      seller_paid_at: now,
      updated_at: now
    }).eq('id', transaction.id).eq('status', 'settlement_due').select('*').maybeSingle();
    if (updateError || !updated) throw new FulfilmentError(409, 'This transaction has already been settled.');
    const { error: loanError } = await db().from('fulfilment_loan_requests').update({
      status: 'funded',
      payout_reference: payoutReference,
      funded_at: now,
      reviewed_by: operator.id
    }).eq('id', loan.id).eq('status', 'approved');
    if (loanError) throw new FulfilmentError(502, 'The seller was paid, but the MFI loan could not be marked as originated.');
    await addEvent(transaction.id, 'settled', `Seller payout ${payoutReference} was confirmed and the MFI salary-deduction loan was originated.`);
    await participantSms(updated, `Transaction ${updated.id.slice(0, 8)} is complete. Seller settlement is confirmed and your salary-deduction loan has been created.`, `Transaction ${updated.id.slice(0, 8)} is complete. Seller payout is confirmed.`, 'settled');
    io.to(`fulfilment:${updated.id}`).emit('fulfilment:updated', { transaction_id: updated.id });
    res.json({ success: true, status: updated.status });
  }));

  router.get('/fleetbase/webhook', route(async (req, res) => {
    verifyFleetbaseWebhookToken(req);
    res.json({ success: true, message: 'Fleetbase webhook endpoint is active; send events using POST.' });
  }));

  router.post('/fleetbase/webhook', route(async (req, res) => {
    verifyFleetbaseWebhookToken(req);
    const data = req.body?.data?.attributes || req.body?.data || req.body?.order || req.body?.payload || req.body;
    const metadata = data?.metadata || data?.payload?.metadata || req.body?.metadata || {};
    const reference = metadata.trustea_transaction_id || data?.external_id || data?.reference || data?.order_number;
    const remoteOrderId = data?.id || req.body?.data?.id || req.body?.order_id;
    const eventName = String(req.body?.event || req.body?.type || '');
    const stage = String(
      data?.trustea_stage ||
      data?.stage ||
      metadata.trustea_stage ||
      data?.activity?.code ||
      data?.activity?.name ||
      data?.status ||
      eventName
    );
    const shopOrderReference = metadata.sumthin_creator_order_id ||
      metadata.creator_order_id ||
      (metadata.sumthin_order_type === 'creator_shop' ? reference : null);
    if (typeof shopOrderReference === 'string' && /^[0-9a-f-]{36}$/i.test(shopOrderReference)) {
      const { data: shopOrder, error: shopLoadError } = await db().from('creator_orders')
        .select('id, status, fulfilment_status, fleetbase_order_id, fleetbase_status, fleetbase_tracking_url, fleetbase_updated_at, delivered_at')
        .eq('id', shopOrderReference)
        .maybeSingle();
      if (shopLoadError) throw new FulfilmentError(502, 'Could not load the Sumthin shop order.');
      if (!shopOrder || !shopOrder.fleetbase_order_id) throw new FulfilmentError(404, 'No active Sumthin shop order matches this Fleetbase event.');
      if (remoteOrderId !== undefined && String(remoteOrderId) !== shopOrder.fleetbase_order_id) {
        throw new FulfilmentError(409, 'Fleetbase order ID does not match the Sumthin shop order.');
      }
      const shopTimeValue = req.body?.created_at || data?.updated_at || req.body?.timestamp;
      const parsedShopTime = typeof shopTimeValue === 'number'
        ? new Date(shopTimeValue > 1e12 ? shopTimeValue : shopTimeValue * 1000)
        : shopTimeValue ? new Date(shopTimeValue) : new Date();
      const shopEventAt = Number.isNaN(parsedShopTime.getTime()) ? new Date() : parsedShopTime;
      if (shopOrder.fleetbase_updated_at &&
          new Date(shopOrder.fleetbase_updated_at).getTime() > shopEventAt.getTime()) {
        res.json({ success: true, ignored: 'stale_event' });
        return;
      }
      const normalizedShopStage = stage.toLowerCase().replace(/[\s.-]+/g, '_');
      const nextShopStatus = ['order_completed', 'completed', 'delivered', 'final_delivery_completed', 'recipient_handover'].includes(normalizedShopStage)
        ? 'delivered'
        : fleetbaseTransactionStatus(stage, shopOrder.fulfilment_status) || shopOrder.fulfilment_status;
      const trackingUrl = resolveFleetbaseTrackingUrl(data, req.body, shopOrder.fleetbase_tracking_url);
      const { data: updatedShopOrder, error: shopUpdateError } = await db().from('creator_orders')
        .update({
          fulfilment_status: nextShopStatus,
          status: nextShopStatus === 'delivered' ? 'fulfilled' : shopOrder.status,
          fleetbase_status: String(data?.status || eventName || stage),
          fleetbase_tracking_url: trackingUrl,
          fleetbase_updated_at: shopEventAt.toISOString(),
          delivered_at: nextShopStatus === 'delivered' ? shopOrder.delivered_at || shopEventAt.toISOString() : shopOrder.delivered_at
        })
        .eq('id', shopOrder.id)
        .eq('fleetbase_order_id', shopOrder.fleetbase_order_id)
        .select('id')
        .maybeSingle();
      if (shopUpdateError || !updatedShopOrder) throw new FulfilmentError(502, 'Could not save the Fleetbase shop-order update.');
      res.json({ success: true, status: nextShopStatus });
      return;
    }
    const query = db().from('fulfilment_transactions').select('*');
    const { data: transaction, error: loadError } = typeof reference === 'string' && /^[0-9a-f-]{36}$/i.test(reference)
      ? await query.eq('id', reference).maybeSingle()
      : remoteOrderId !== undefined
        ? await query.eq('fleetbase_order_id', String(remoteOrderId)).maybeSingle()
        : { data: null, error: null };
    if (loadError) throw new FulfilmentError(502, 'Could not load the Fleetbase transaction.');
    if (!transaction || !transaction.fleetbase_order_id) throw new FulfilmentError(404, 'No active Trustea order matches this Fleetbase event.');
    if (remoteOrderId !== undefined && String(remoteOrderId) !== transaction.fleetbase_order_id) {
      throw new FulfilmentError(409, 'Fleetbase order ID does not match the Trustea transaction.');
    }

    const nextStatus = fleetbaseTransactionStatus(stage, transaction.status);
    const rawStatus = String(data?.status || eventName || stage);
    const timeValue = req.body?.created_at || data?.updated_at || req.body?.timestamp;
    const parsedTime = typeof timeValue === 'number'
      ? new Date(timeValue > 1e12 ? timeValue : timeValue * 1000)
      : timeValue ? new Date(timeValue) : new Date();
    const eventAt = Number.isNaN(parsedTime.getTime()) ? new Date() : parsedTime;
    if (transaction.fleetbase_updated_at &&
        new Date(transaction.fleetbase_updated_at).getTime() > eventAt.getTime()) {
      res.json({ success: true, ignored: 'stale_event' });
      return;
    }

    const nextStatusValue = nextStatus || transaction.status;
    const statusChanged = nextStatusValue !== transaction.status;
    const driver = data?.driver_location || data?.location || req.body?.driver_location;
    const latitude = Number(driver?.latitude ?? driver?.lat);
    const longitude = Number(driver?.longitude ?? driver?.lng);
    const hasLocation = Number.isFinite(latitude) && Number.isFinite(longitude) &&
      latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
    const deliveredAt = nextStatusValue === 'delivered'
      ? transaction.delivered_at || eventAt.toISOString()
      : transaction.delivered_at;
    const pickedUpAt = nextStatusValue === 'in_transit'
      ? transaction.picked_up_at || eventAt.toISOString()
      : transaction.picked_up_at;
    const handoverAt = nextStatusValue === 'at_fleetbase_location'
      ? transaction.fleetbase_location_handed_over_at || eventAt.toISOString()
      : transaction.fleetbase_location_handed_over_at;
    const trackingUrl = resolveFleetbaseTrackingUrl(data, req.body, transaction.fleetbase_tracking_url);
    const update: Record<string, unknown> = {
      fleetbase_status: rawStatus,
      fleetbase_updated_at: eventAt.toISOString(),
      fleetbase_tracking_url: trackingUrl,
      status: nextStatusValue,
      picked_up_at: pickedUpAt,
      fleetbase_location_handed_over_at: handoverAt,
      delivered_at: deliveredAt,
      updated_at: new Date().toISOString()
    };
    if (hasLocation) {
      update.driver_location = { latitude, longitude, updated_at: eventAt.toISOString() };
    }
    const { data: updated, error: updateError } = await db().from('fulfilment_transactions')
      .update(update)
      .eq('id', transaction.id)
      .eq('fleetbase_order_id', transaction.fleetbase_order_id)
      .select('*')
      .maybeSingle();
    if (updateError || !updated) throw new FulfilmentError(502, 'Could not save the Fleetbase status update.');

    if (statusChanged) {
      const eventType = `fleetbase_${nextStatusValue}`;
      const descriptions: Record<string, string> = {
        delivery_pending: 'Fleetbase accepted the order and is preparing delivery.',
        in_transit: 'Fleetbase has collected the item and is delivering it to the buyer.',
        at_fleetbase_location: 'Fleetbase reported the item at one of its facilities.',
        fleetbase_aggregation: 'Fleetbase received the item into its aggregation workflow.',
        fleetbase_middle_mile: 'Fleetbase is moving the item through its middle-mile network.',
        final_delivery: 'Fleetbase has started the final delivery to the buyer.',
        delivered: 'Fleetbase confirmed delivery to the buyer. The buyer can confirm receipt.',
        delivery_exception: 'Fleetbase reported a delivery exception. Settlement is paused.'
      };
      await addEvent(transaction.id, eventType, descriptions[nextStatusValue] || 'Fleetbase updated this order.');
      const messages: Record<string, { buyer: string; seller: string }> = {
        delivery_pending: {
          buyer: 'Fleetbase has accepted your order and is preparing delivery.',
          seller: 'Fleetbase is preparing pickup of your item.'
        },
        in_transit: {
          buyer: 'Fleetbase has collected your item and is delivering it to you.',
          seller: 'Fleetbase has collected your item and is delivering it to the buyer.'
        },
        at_fleetbase_location: {
          buyer: 'Fleetbase reported your item at one of its facilities.',
          seller: 'Fleetbase reported the item at one of its facilities.'
        },
        fleetbase_aggregation: {
          buyer: 'Fleetbase is sorting your item for onward delivery.',
          seller: 'Fleetbase has received your item and started aggregation.'
        },
        fleetbase_middle_mile: {
          buyer: 'Your item is moving through Fleetbase middle-mile delivery.',
          seller: 'Your item is moving through Fleetbase middle-mile delivery.'
        },
        final_delivery: {
          buyer: 'Fleetbase has started the final delivery to your location.',
          seller: 'Fleetbase has started the final delivery to the buyer.'
        },
        delivered: {
          buyer: 'Fleetbase delivered your item. Confirm receipt in Trustea to start the 24-hour return window.',
          seller: 'Fleetbase delivered the item to the buyer, who can now confirm receipt.'
        },
        delivery_exception: {
          buyer: 'Fleetbase reported a delivery issue. Trustea support will follow up.',
          seller: 'Fleetbase reported a delivery issue. Trustea support will follow up.'
        }
      };
      const notification = messages[nextStatusValue];
      if (notification) {
        await participantSms(updated, notification.buyer, notification.seller, eventType);
      }
    }
    io.to(`fulfilment:${transaction.id}`).emit('fulfilment:updated', { transaction_id: transaction.id });
    res.json({ success: true, status: updated.status });
  }));

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof FulfilmentError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error('[Fulfilment] Unexpected request error:', error);
    res.status(500).json({ error: 'An unexpected fulfilment error occurred.' });
  });

  return router;
}

export function addFulfilmentSocketHandlers(io: SocketIOServer): void {
  io.on('connection', (socket: Socket) => {
    socket.on('fulfilment:subscribe', async (payload: { transaction_id?: unknown; token?: unknown }) => {
      try {
        if (typeof payload?.transaction_id !== 'string' || typeof payload.token !== 'string') return;
        const transaction = await loadTransaction(payload.transaction_id);
        const hash = tokenHash(payload.token);
        if (equalHash(hash, transaction.buyer_token_hash) || equalHash(hash, transaction.seller_token_hash)) {
          socket.join(`fulfilment:${transaction.id}`);
        } else {
          socket.emit('fulfilment:error', { transaction_id: payload.transaction_id, message: 'This private transaction link is invalid.' });
        }
      } catch {
        socket.emit('fulfilment:error', { transaction_id: payload?.transaction_id, message: 'Could not subscribe to transaction updates.' });
      }
    });
  });
}

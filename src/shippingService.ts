import { v4 as uuidv4 } from 'uuid';
import { inMemoryStore, supabase } from './supabaseClient';
import { Server as SocketIOServer } from 'socket.io';

export interface ShippingOrder {
  id: string;
  order_number: string;
  mode: 'TRUSTEA_P2P' | 'GOV_FOOD_DELIVERY';
  status: 'READY_FOR_PICKUP' | 'RIDER_ARRIVED' | 'PICKED_UP_IN_TRANSIT' | 'DELIVERED' | 'CANCELLED';
  sender_name: string;
  sender_phone: string;
  sender_location: string;
  sender_facility?: string;
  recipient_name: string;
  recipient_phone: string;
  recipient_location: string;
  recipient_facility?: string;
  item_title: string;
  item_description: string;
  item_category: string;
  declared_value: number;
  delivery_fee: number;
  special_instructions: string;
  rider_id: string;
  rider_name: string;
  rider_phone: string;
  collected_photos: Array<{ id: string; url: string; label: string; timestamp: string }>;
  sender_signature_data?: string;
  sender_signatory_name?: string;
  picked_up_at?: string;
  delivered_at?: string;
  created_at: string;
  updated_at: string;
}

// In-Memory store for Shipping Orders
export const shippingOrders = new Map<string, ShippingOrder>();

// Pre-seed high-fidelity real world orders
const defaultShippingOrders: ShippingOrder[] = [
  {
    id: 'ship-gov-001',
    order_number: 'GOV-UTH-CC-8491',
    mode: 'GOV_FOOD_DELIVERY',
    status: 'READY_FOR_PICKUP',
    sender_name: 'Mrs. Gertrude Mwape (Head Chef)',
    sender_phone: '+260977223344',
    sender_location: 'University Teaching Hospital (UTH) Staff Kitchens & Canteen, Nationalist Rd, Lusaka',
    sender_facility: 'UTH Dietary & Catering Section, Block D',
    recipient_name: 'Chilufya Musonda (Senior Accountant)',
    recipient_phone: '+260971556677',
    recipient_location: 'Lusaka Civic Center, Independence Avenue, Lusaka',
    recipient_facility: 'Directorate of Finance & Planning, 2nd Floor, Room 214',
    item_title: 'Hot Lunch Pack: Roast Village Chicken, Traditional Nshima & Lumanda (Order #8491)',
    item_description: 'Sealed double-portion hot government worker lunch in thermal insulated tote with fresh cutlery.',
    item_category: 'Hot Lunch / Gov Meal Delivery',
    declared_value: 140.00,
    delivery_fee: 30.00,
    special_instructions: 'Delivery along UTH-Civic Center corridor. Please keep container upright. Sender signature mandatory on pickup.',
    rider_id: 'rider-lusaka-01',
    rider_name: 'Kelvin Musonda (Tuk-Tuk Express #14)',
    rider_phone: '+260979456789',
    collected_photos: [],
    created_at: new Date(Date.now() - 3600000).toISOString(),
    updated_at: new Date(Date.now() - 3600000).toISOString()
  },
  {
    id: 'ship-p2p-002',
    order_number: 'TRU-LUS-7721',
    mode: 'TRUSTEA_P2P',
    status: 'READY_FOR_PICKUP',
    sender_name: 'Bwalya Chanda (Verified Seller)',
    sender_phone: '+260978990011',
    sender_location: 'Arcades Shopping Mall (Near Spar Entrance), Great East Rd, Lusaka',
    sender_facility: 'Arcades North Parking Bay 4',
    recipient_name: 'Miriam Banda (Escrow Buyer)',
    recipient_phone: '+260975334455',
    recipient_location: 'Woodlands Shopping Centre, Lusaka',
    recipient_facility: 'Woodlands Main Entrance Courtyard',
    item_title: 'Samsung 32-inch Smart LED TV + Wall Mount & Remote',
    item_description: 'Sealed in retail packaging with Trustea Escrow tamper-evident security barcode #SEAL-9012.',
    item_category: 'Electronics / Peer-to-Peer Escrow',
    declared_value: 2800.00,
    delivery_fee: 65.00,
    special_instructions: 'Confirm buyer escrow is funded before dispatch. Photograph seal and collect seller signature on handover.',
    rider_id: 'rider-lusaka-01',
    rider_name: 'Kelvin Musonda (Tuk-Tuk Express #14)',
    rider_phone: '+260979456789',
    collected_photos: [],
    created_at: new Date(Date.now() - 7200000).toISOString(),
    updated_at: new Date(Date.now() - 7200000).toISOString()
  },
  {
    id: 'ship-gov-003',
    order_number: 'GOV-UTH-CC-9015',
    mode: 'GOV_FOOD_DELIVERY',
    status: 'READY_FOR_PICKUP',
    sender_name: 'UTH Nutrition & Dietary Services',
    sender_phone: '+260976112233',
    sender_location: 'UTH Main Outpatients Annex Kitchen, Nationalist Rd, Lusaka',
    sender_facility: 'Dietary Unit 2',
    recipient_name: 'Eng. Mwamba Kasengele (City Engineer)',
    recipient_phone: '+260979887766',
    recipient_location: 'Civic Center Annex, Department of Engineering Services, Lusaka',
    recipient_facility: 'City Planning Directorate, 1st Floor, Room 108',
    item_title: 'Dietary Hot Lunch: Grilled Kariba Bream Fish, Brown Rice & Steamed Greens',
    item_description: 'Custom healthy meal package with low-sodium gravy and lemon dressing.',
    item_category: 'Hot Lunch / Gov Meal Delivery',
    declared_value: 160.00,
    delivery_fee: 30.00,
    special_instructions: 'Keep hot container sealed. Express priority for 12:30 lunch meeting.',
    rider_id: 'rider-lusaka-01',
    rider_name: 'Kelvin Musonda (Tuk-Tuk Express #14)',
    rider_phone: '+260979456789',
    collected_photos: [],
    created_at: new Date(Date.now() - 1800000).toISOString(),
    updated_at: new Date(Date.now() - 1800000).toISOString()
  }
];

// Initialize store
defaultShippingOrders.forEach(o => shippingOrders.set(o.id, o));

export function getShippingOrders(mode?: string) {
  const all = Array.from(shippingOrders.values()).reverse();
  if (mode) {
    return all.filter(o => o.mode === mode);
  }
  return all;
}

export function getShippingOrderById(idOrOrderNum: string) {
  const byId = shippingOrders.get(idOrOrderNum);
  if (byId) return byId;
  for (const o of shippingOrders.values()) {
    if (o.order_number.toLowerCase() === idOrOrderNum.toLowerCase()) {
      return o;
    }
  }
  return null;
}

export function createShippingOrder(payload: Partial<ShippingOrder>): ShippingOrder {
  const id = uuidv4();
  const orderNumber = payload.order_number || (payload.mode === 'GOV_FOOD_DELIVERY' 
    ? `GOV-UTH-CC-${Math.floor(1000 + Math.random() * 9000)}` 
    : `TRU-LUS-${Math.floor(1000 + Math.random() * 9000)}`);

  const newOrder: ShippingOrder = {
    id,
    order_number: orderNumber,
    mode: payload.mode || 'GOV_FOOD_DELIVERY',
    status: 'READY_FOR_PICKUP',
    sender_name: payload.sender_name || 'Sender',
    sender_phone: payload.sender_phone || '+260970000000',
    sender_location: payload.sender_location || 'Lusaka, Zambia',
    sender_facility: payload.sender_facility || '',
    recipient_name: payload.recipient_name || 'Recipient',
    recipient_phone: payload.recipient_phone || '+260970000000',
    recipient_location: payload.recipient_location || 'Lusaka, Zambia',
    recipient_facility: payload.recipient_facility || '',
    item_title: payload.item_title || 'Package',
    item_description: payload.item_description || '',
    item_category: payload.item_category || 'General Delivery',
    declared_value: Number(payload.declared_value) || 0,
    delivery_fee: Number(payload.delivery_fee) || 30.00,
    special_instructions: payload.special_instructions || '',
    rider_id: payload.rider_id || 'rider-lusaka-01',
    rider_name: payload.rider_name || 'Kelvin Musonda',
    rider_phone: payload.rider_phone || '+260979456789',
    collected_photos: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  shippingOrders.set(id, newOrder);

  // Sync to Supabase if configured
  try {
    supabase.from('shipping_pickup_orders').insert(newOrder);
  } catch (e) {}

  return newOrder;
}

export function executeShippingPickup(
  io: SocketIOServer,
  orderId: string,
  data: {
    photos: Array<{ id: string; url: string; label: string; timestamp: string }>;
    signature_data: string;
    signatory_name: string;
    rider_notes?: string;
  }
): ShippingOrder {
  const order = getShippingOrderById(orderId);
  if (!order) {
    throw new Error(`Shipping order ${orderId} not found`);
  }

  const now = new Date().toISOString();
  order.status = 'PICKED_UP_IN_TRANSIT';
  order.collected_photos = data.photos || [];
  order.sender_signature_data = data.signature_data;
  order.sender_signatory_name = data.signatory_name || order.sender_name;
  order.picked_up_at = now;
  order.updated_at = now;

  // Broadcast real-time updates to MFI Software and Customer monitoring
  io.emit('shipping:order_updated', order);
  io.emit('shipping:picked_up', {
    order_id: order.id,
    order_number: order.order_number,
    mode: order.mode,
    item_title: order.item_title,
    sender_name: order.sender_name,
    signatory_name: order.sender_signatory_name,
    photos_count: order.collected_photos.length,
    picked_up_at: order.picked_up_at
  });

  // Sync with Supabase
  try {
    supabase.from('shipping_pickup_orders').update({
      status: 'PICKED_UP_IN_TRANSIT',
      collected_photos: order.collected_photos,
      sender_signature_data: order.sender_signature_data,
      sender_signatory_name: order.sender_signatory_name,
      picked_up_at: now,
      updated_at: now
    }).eq('id', order.id);
  } catch (e) {}

  console.log(`[Shipping Service] Order ${order.order_number} successfully picked up! Photos: ${order.collected_photos.length}, Signed by: ${order.sender_signatory_name}`);
  return order;
}

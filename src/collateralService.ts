import { v4 as uuidv4 } from 'uuid';
import { inMemoryStore, supabase } from './supabaseClient';
import { Server as SocketIOServer } from 'socket.io';

export interface CollateralItem {
  id: string;
  collateral_code: string;
  borrower_id?: string;
  borrower_name: string;
  borrower_phone: string;
  borrower_nrc: string;
  borrower_address: string;
  item_category: 'SMARTPHONE' | 'LAPTOP' | 'POWER_SOLAR' | 'APPLIANCE' | 'MOTORBIKE' | 'TOOLS';
  item_make: string;
  item_model: string;
  questionnaire_responses: Record<string, any>;
  estimated_fmv: number; // Fair Market Value (ZMW)
  condition_grade: 'Grade A+' | 'Grade A' | 'Grade B' | 'Grade C';
  loan_to_value_pct: number; // e.g. 72.00%
  approved_credit_limit: number; // Maximized for borrower adoption
  mfi_headroom_margin: number; // Headroom reserve for collateral liquidation
  status: 'VALUATION_COMPLETED' | 'PENDING_PICKUP' | 'RIDER_INSPECTING' | 'ACCEPTED_AND_TRANSIT' | 'IN_MFI_VAULT' | 'REJECTED';
  rider_id: string;
  rider_name: string;
  inspection_photos: Array<{ id: string; url: string; label: string; timestamp: string }>;
  borrower_signature_data?: string;
  handover_at?: string;
  instapay_account_activated: boolean;
  instapay_sms_sent: boolean;
  instapay_sms_text?: string;
  instapay_activation_url?: string;
  created_at: string;
  updated_at: string;
}

export const collateralPickups = new Map<string, CollateralItem>();

// Baseline market pricing benchmark for Zambia (in ZMW)
const ZAMBIA_MARKET_BENCHMARKS: Record<string, number> = {
  // Smartphones
  'iphone 15 pro max': 22500,
  'iphone 15 pro': 19500,
  'iphone 14 pro': 14800,
  'iphone 14': 11500,
  'iphone 13 pro': 12200,
  'iphone 13': 9800,
  'iphone 12': 7200,
  'iphone 11': 5400,
  'samsung galaxy s24 ultra': 21000,
  'samsung galaxy s23 ultra': 15500,
  'samsung galaxy s22': 9500,
  'samsung galaxy a54': 4800,
  'samsung galaxy a34': 3900,
  'samsung galaxy a14': 2500,

  // Laptops
  'macbook air m2': 17500,
  'macbook air m1': 13000,
  'macbook pro 14': 24000,
  'hp probook 450 g8': 6500,
  'hp elitebook 840 g6': 5200,
  'dell latitude 5420': 6800,
  'lenovo thinkpad t14': 7400,

  // Solar & Inverters
  'luminous solar 3.5kva inverter + 2x200ah gel': 14500,
  'must 5kw hybrid solar inverter': 12800,
  'felicity solar 5kwh lithium battery': 19000,
  '200ah gel deep cycle solar battery': 4200,

  // Home Appliances
  'hisense 55 inch 4k smart tv': 7200,
  'samsung 43 inch smart full hd tv': 5200,
  'defy chest freezer 254l': 5800,
  'hisense double door fridge 205l': 4600,

  // Motorbikes
  'bajaj boxer 150': 18500,
  'tvs hlx 125': 16000,
  'honda ace 125': 19500
};

// Automated valuation calculation
export function calculateCollateralValuation(payload: {
  category: 'SMARTPHONE' | 'LAPTOP' | 'POWER_SOLAR' | 'APPLIANCE' | 'MOTORBIKE' | 'TOOLS';
  make?: string;
  brand?: string;
  model?: string;
  title?: string;
  declared_purchase_price?: number;
  condition?: 'MINT' | 'EXCELLENT' | 'GOOD' | 'FAIR';
  functional_health?: 'PERFECT_100' | 'MINOR_QUIRK' | 'DEGRADED';
  device_age?: 'UNDER_6_MONTHS' | '6_TO_12_MONTHS' | '1_TO_2_YEARS' | 'OVER_2_YEARS';
  account_lock_status?: 'CLEAN_UNLOCKED' | 'LOCKED';
  accessories?: string[]; // ['box', 'charger', 'receipt']
}): {
  fmv: number;
  condition_grade: 'Grade A+' | 'Grade A' | 'Grade B' | 'Grade C';
  ltv_pct: number;
  approved_credit_limit: number;
  mfi_headroom_margin: number;
  valuation_breakdown: any;
} {
  const makeStr = String(payload.make || payload.brand || '').trim();
  const modelStr = String(payload.model || payload.title || '').trim();
  const normalizedKey = `${makeStr} ${modelStr}`.trim().toLowerCase();
  
  // Find closest benchmark or fallback to declared purchase price
  let baseBenchmark = ZAMBIA_MARKET_BENCHMARKS[normalizedKey];
  if (!baseBenchmark) {
    // Try partial match
    for (const [k, v] of Object.entries(ZAMBIA_MARKET_BENCHMARKS)) {
      if (normalizedKey.includes(k) || k.includes(normalizedKey)) {
        baseBenchmark = v;
        break;
      }
    }
  }

  if (!baseBenchmark) {
    const declared = Number(payload.declared_purchase_price) || 4000;
    baseBenchmark = declared * 0.75; // Depreciate initial retail
  }

  // Multiplier for cosmetic condition
  let conditionFactor = 1.0;
  if (payload.condition === 'MINT') conditionFactor = 1.0;
  else if (payload.condition === 'EXCELLENT') conditionFactor = 0.93;
  else if (payload.condition === 'GOOD') conditionFactor = 0.85;
  else conditionFactor = 0.74;

  // Multiplier for functional health
  let healthFactor = 1.0;
  if (payload.functional_health === 'PERFECT_100') healthFactor = 1.0;
  else if (payload.functional_health === 'MINOR_QUIRK') healthFactor = 0.88;
  else healthFactor = 0.65;

  // Multiplier for age
  let ageFactor = 1.0;
  if (payload.device_age === 'UNDER_6_MONTHS') ageFactor = 1.0;
  else if (payload.device_age === '6_TO_12_MONTHS') ageFactor = 0.92;
  else if (payload.device_age === '1_TO_2_YEARS') ageFactor = 0.83;
  else ageFactor = 0.72;

  // Bonus for accessories
  let accessoryBonus = 0;
  if (payload.accessories?.includes('box')) accessoryBonus += 0.04;
  if (payload.accessories?.includes('charger')) accessoryBonus += 0.04;
  if (payload.accessories?.includes('receipt')) accessoryBonus += 0.05;

  // Disqualification check
  if (payload.account_lock_status === 'LOCKED') {
    throw new Error('Item has active iCloud / Google FRP account lock. Unlocking is mandatory before collateral appraisal.');
  }

  // Compute Fair Market Value (FMV)
  const rawFmv = baseBenchmark * conditionFactor * healthFactor * ageFactor * (1 + accessoryBonus);
  const fmv = Math.round(rawFmv / 50) * 50;

  // Determine Condition Grade & High-Borrower-Adoption LTV
  let condition_grade: 'Grade A+' | 'Grade A' | 'Grade B' | 'Grade C' = 'Grade B';
  let ltv_pct = 70.0;

  if (conditionFactor >= 0.95 && healthFactor === 1.0 && ageFactor >= 0.9) {
    condition_grade = 'Grade A+';
    ltv_pct = 75.0; // Maximized borrowing capacity!
  } else if (conditionFactor >= 0.85 && healthFactor >= 0.9) {
    condition_grade = 'Grade A';
    ltv_pct = 72.0;
  } else if (conditionFactor >= 0.75) {
    condition_grade = 'Grade B';
    ltv_pct = 66.0;
  } else {
    condition_grade = 'Grade C';
    ltv_pct = 56.0;
  }

  const approved_credit_limit = Math.round((fmv * (ltv_pct / 100)) / 50) * 50;
  const mfi_headroom_margin = fmv - approved_credit_limit;

  return {
    fmv,
    condition_grade,
    ltv_pct,
    approved_credit_limit,
    mfi_headroom_margin,
    valuation_breakdown: {
      baseBenchmark,
      conditionFactor,
      healthFactor,
      ageFactor,
      accessoryBonus,
      headroomPercentage: (100 - ltv_pct).toFixed(1) + '%'
    }
  };
}

// Pre-seed sample collateral items
const defaultCollateralItems: CollateralItem[] = [
  {
    id: 'col-lus-001',
    collateral_code: 'COL-IP13-8821',
    borrower_name: 'Mwamba Chileshe',
    borrower_phone: '0978587412',
    borrower_nrc: '348912/11/1',
    borrower_address: 'Plot 48, Longacres, Lusaka',
    item_category: 'SMARTPHONE',
    item_make: 'Apple',
    item_model: 'iPhone 13 128GB Midnight',
    questionnaire_responses: {
      condition: 'EXCELLENT',
      functional_health: 'PERFECT_100',
      device_age: '6_TO_12_MONTHS',
      battery_health: 89,
      storage: '128GB',
      account_lock_status: 'CLEAN_UNLOCKED',
      accessories: ['box', 'charger']
    },
    estimated_fmv: 9500.00,
    condition_grade: 'Grade A',
    loan_to_value_pct: 72.00,
    approved_credit_limit: 6850.00,
    mfi_headroom_margin: 2650.00,
    status: 'PENDING_PICKUP',
    rider_id: 'rider-lusaka-01',
    rider_name: 'Kelvin Musonda',
    inspection_photos: [],
    instapay_account_activated: false,
    instapay_sms_sent: false,
    created_at: new Date(Date.now() - 7200000).toISOString(),
    updated_at: new Date(Date.now() - 7200000).toISOString()
  },
  {
    id: 'col-lus-002',
    collateral_code: 'COL-SOL-4419',
    borrower_name: 'Natasha Tembo',
    borrower_phone: '0977123456',
    borrower_nrc: '512398/10/1',
    borrower_address: 'House 12, Kabwata Site & Service, Lusaka',
    item_category: 'POWER_SOLAR',
    item_make: 'Luminous',
    item_model: 'Solar 3.5kVA Pure Sine Wave Inverter + 200Ah Gel Battery',
    questionnaire_responses: {
      condition: 'MINT',
      functional_health: 'PERFECT_100',
      device_age: 'UNDER_6_MONTHS',
      capacity: '3.5kVA / 24V',
      account_lock_status: 'CLEAN_UNLOCKED',
      accessories: ['box', 'receipt']
    },
    estimated_fmv: 14000.00,
    condition_grade: 'Grade A+',
    loan_to_value_pct: 75.00,
    approved_credit_limit: 10500.00,
    mfi_headroom_margin: 3500.00,
    status: 'PENDING_PICKUP',
    rider_id: 'rider-lusaka-01',
    rider_name: 'Kelvin Musonda',
    inspection_photos: [],
    instapay_account_activated: false,
    instapay_sms_sent: false,
    created_at: new Date(Date.now() - 3600000).toISOString(),
    updated_at: new Date(Date.now() - 3600000).toISOString()
  }
];

defaultCollateralItems.forEach(c => collateralPickups.set(c.id, c));

export function getCollateralPickups() {
  return Array.from(collateralPickups.values()).reverse();
}

export function getCollateralById(idOrCode: string) {
  const byId = collateralPickups.get(idOrCode);
  if (byId) return byId;
  for (const c of collateralPickups.values()) {
    if (c.collateral_code.toLowerCase() === idOrCode.toLowerCase()) {
      return c;
    }
  }
  return null;
}

export function createCollateralAppraisal(payload: any): CollateralItem {
  const itemMake = String(payload.item_make || payload.make || payload.brand || 'ITEM').trim();
  const itemModel = String(payload.item_model || payload.model || payload.title || 'DEVICE').trim();
  const itemCategory = payload.item_category || payload.category || 'SMARTPHONE';

  const valuation = calculateCollateralValuation({
    category: itemCategory,
    make: itemMake,
    model: itemModel,
    declared_purchase_price: payload.declared_purchase_price,
    condition: payload.condition || 'EXCELLENT',
    functional_health: payload.functional_health || 'PERFECT_100',
    device_age: payload.device_age || '6_TO_12_MONTHS',
    account_lock_status: payload.account_lock_status || 'CLEAN_UNLOCKED',
    accessories: payload.accessories || []
  });

  const id = uuidv4();
  const safePrefix = (itemMake.slice(0, 3) || 'COL').toUpperCase();
  const code = `COL-${safePrefix}-${Math.floor(1000 + Math.random() * 9000)}`;

  const item: CollateralItem = {
    id,
    collateral_code: code,
    borrower_name: payload.borrower_name || 'Borrower',
    borrower_phone: payload.borrower_phone || '0970000000',
    borrower_nrc: payload.borrower_nrc || '111111/11/1',
    borrower_address: payload.borrower_address || 'Lusaka, Zambia',
    item_category: itemCategory,
    item_make: itemMake,
    item_model: itemModel,
    questionnaire_responses: payload.questionnaire_responses || payload,
    estimated_fmv: valuation.fmv,
    condition_grade: valuation.condition_grade,
    loan_to_value_pct: valuation.ltv_pct,
    approved_credit_limit: valuation.approved_credit_limit,
    mfi_headroom_margin: valuation.mfi_headroom_margin,
    status: 'PENDING_PICKUP',
    rider_id: payload.rider_id || 'rider-lusaka-01',
    rider_name: payload.rider_name || 'Kelvin Musonda',
    inspection_photos: [],
    instapay_account_activated: false,
    instapay_sms_sent: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  collateralPickups.set(id, item);

  try {
    supabase.from('collateral_pickups').insert(item);
  } catch (e) {}

  return item;
}

// Executes collateral pickup and triggers immediate InstaPay account creation + SMS dispatch
export function executeCollateralPickupAndActivateInstaPay(
  io: SocketIOServer,
  collateralId: string,
  data: {
    photos: Array<{ id: string; url: string; label: string; timestamp: string }>;
    signature_data: string;
    rider_notes?: string;
  }
): { collateral: CollateralItem; borrower: any; smsMessage: string } {
  const item = getCollateralById(collateralId);
  if (!item) {
    throw new Error(`Collateral record ${collateralId} not found`);
  }

  const now = new Date().toISOString();
  item.status = 'ACCEPTED_AND_TRANSIT';
  item.inspection_photos = data.photos || [];
  item.borrower_signature_data = data.signature_data;
  item.handover_at = now;
  item.updated_at = now;

  // 1. TIGHT COUPLING WITH INSTAPAY: Create or update Borrower in MFI Software
  let borrower = inMemoryStore.borrowers.find(b => b.phone_number === item.borrower_phone.trim());
  if (borrower) {
    borrower.credit_limit = Math.max(borrower.credit_limit, item.approved_credit_limit);
    borrower.status = 'active';
  } else {
    borrower = {
      id: uuidv4(),
      full_name: item.borrower_name,
      phone_number: item.borrower_phone.trim(),
      nrc_number: item.borrower_nrc || `ZM-${Math.floor(100000 + Math.random() * 900000)}/11/1`,
      credit_limit: item.approved_credit_limit,
      current_outstanding: 0.00,
      daily_borrowed_today: 0.00,
      status: 'active'
    };
    inMemoryStore.borrowers.push(borrower);
  }

  item.borrower_id = borrower.id;
  item.instapay_account_activated = true;

  // 2. DISPATCH INSTANT SMS WITH PRE-AUTHENTICATED INSTAPAY LINK
  const customerAppUrl = process.env.CUSTOMER_APP_URL || 'http://localhost:3003';
  const activationUrl = `${customerAppUrl}?phone=${encodeURIComponent(borrower.phone_number)}&activated=collateral`;
  const smsBody = `Trustea InstaPay: Your collateral ${item.item_make} ${item.item_model} is verified! Instant credit line of ZMW ${item.approved_credit_limit.toFixed(2)} is now ACTIVE. Tap to Send Money or Get Cash immediately: ${activationUrl}`;

  item.instapay_sms_sent = true;
  item.instapay_sms_text = smsBody;
  item.instapay_activation_url = activationUrl;

  // Register in carrier SMS feed
  const smsLog = {
    id: `sms-col-${Date.now()}`,
    gateway_device_id: inMemoryStore.gateway.id,
    sender: 'TrusteaInstapay',
    raw_sms: smsBody,
    parsed_transaction_id: `COL-ACT-${item.collateral_code}`,
    parsed_amount: item.approved_credit_limit,
    parsed_recipient_or_agent: `${borrower.full_name} (${borrower.phone_number})`,
    parsed_balance_after: inMemoryStore.gateway.balance,
    matched_loan_id: null,
    verified: true,
    created_at: now
  };

  inMemoryStore.smsLogs.unshift(smsLog);

  // Sync with Supabase
  try {
    supabase.from('borrowers').upsert(borrower);
    supabase.from('collateral_pickups').update({
      status: 'ACCEPTED_AND_TRANSIT',
      inspection_photos: item.inspection_photos,
      borrower_signature_data: item.borrower_signature_data,
      borrower_id: borrower.id,
      handover_at: now,
      instapay_account_activated: true,
      instapay_sms_sent: true,
      instapay_sms_text: smsBody,
      instapay_activation_url: activationUrl,
      updated_at: now
    }).eq('id', item.id);
    supabase.from('carrier_sms_logs').insert(smsLog);
  } catch (e) {}

  // Broadcast to MFI Software and Customer monitoring via Socket.IO
  io.emit('collateral:pickup_completed', {
    collateral: item,
    borrower,
    sms: smsLog
  });
  io.emit('mfi:borrower_updated', borrower);
  io.emit('carrier:sms_received', { logEntry: smsLog });

  console.log(`[Collateral Service] Collateral ${item.collateral_code} validated & picked up! InstaPay credit line of ZMW ${item.approved_credit_limit} activated for ${borrower.full_name}. SMS dispatched: ${smsBody}`);

  return { collateral: item, borrower, smsMessage: smsBody };
}

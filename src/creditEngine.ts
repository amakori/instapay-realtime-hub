import { inMemoryStore, supabase } from './supabaseClient';

export interface CreditEvaluationResult {
  eligible: boolean;
  reasons: string[];
  borrower: {
    id?: string;
    full_name: string;
    phone_number: string;
    credit_limit: number;
    current_outstanding: number;
    remaining_credit: number;
  } | null;
  checks: {
    emergency_freeze_passed: boolean;
    amount_range_passed: boolean;
    government_cap_passed: boolean;
    borrower_limit_passed: boolean;
    daily_borrower_cap_passed: boolean;
    gateway_balance_passed: boolean;
    gateway_status_passed: boolean;
  };
  limits: {
    requested_amount: number;
    min_single_loan: number;
    max_single_loan: number;
    government_max_loan: number;
    gateway_balance: number;
    gateway_buffer: number;
  };
}

export async function evaluateInstaLoan(
  borrowerPhone: string,
  requestedAmount: number,
  loanType: 'SEND_MONEY' | 'GET_CASH',
  gatewayId = 'gateway-airtel-01'
): Promise<CreditEvaluationResult> {
  const reasons: string[] = [];
  const settings = inMemoryStore.settings;
  const gateway = inMemoryStore.gateway;

  // 1. Borrower Lookup
  let borrower = inMemoryStore.borrowers.find(b => b.phone_number === borrowerPhone.trim());
  if (!borrower) {
    // If not found in memory, try Supabase
    try {
      const { data } = await supabase.from('borrowers').select('*').eq('phone_number', borrowerPhone.trim()).single();
      if (data) borrower = data;
    } catch (e) {}
  }

  // Fallback: If demo user not yet registered, register with default initial limit for seamless onboarding
  if (!borrower) {
    borrower = {
      id: `usr-${Date.now()}`,
      full_name: 'Instapay Borrower (' + borrowerPhone.slice(-4) + ')',
      phone_number: borrowerPhone.trim(),
      nrc_number: `ZM-${Math.floor(100000 + Math.random() * 900000)}/11/1`,
      credit_limit: 1500.00,
      current_outstanding: 0.00,
      daily_borrowed_today: 0.00,
      status: 'active'
    };
    inMemoryStore.borrowers.push(borrower);
  }

  // 2. Safeguard 1: Emergency Freeze Dispensing Check
  const emergency_freeze_passed = !settings.emergency_freeze_dispensing;
  if (!emergency_freeze_passed) {
    reasons.push('MFI Emergency Freeze: Mobile money dispensing is currently paused by lender risk controls.');
  }

  // 3. Safeguard 2: Min / Max Loan Limits
  const amount_range_passed = requestedAmount >= settings.min_single_loan && requestedAmount <= settings.max_single_loan;
  if (requestedAmount < settings.min_single_loan) {
    reasons.push(`Requested amount (ZMW ${requestedAmount.toFixed(2)}) is below the minimum loan threshold of ZMW ${settings.min_single_loan.toFixed(2)}.`);
  }
  if (requestedAmount > settings.max_single_loan) {
    reasons.push(`Requested amount (ZMW ${requestedAmount.toFixed(2)}) exceeds the MFI single loan maximum of ZMW ${settings.max_single_loan.toFixed(2)}.`);
  }

  // 4. Safeguard 3: Government Statutory Limits
  const government_cap_passed = requestedAmount <= settings.government_max_loan_limit;
  if (!government_cap_passed) {
    reasons.push(`Requested amount violates the government micro-lending cap of ZMW ${settings.government_max_loan_limit.toFixed(2)}.`);
  }

  // 5. Safeguard 4: Borrower Credit Limit & Status
  let borrower_limit_passed = false;
  let daily_borrower_cap_passed = false;

  if (borrower.status !== 'active') {
    reasons.push(`Borrower account is ${borrower.status.toUpperCase()}. Loan applications are suspended.`);
  } else {
    const totalPotentialDebt = borrower.current_outstanding + requestedAmount;
    borrower_limit_passed = totalPotentialDebt <= borrower.credit_limit;
    if (!borrower_limit_passed) {
      reasons.push(`Loan would exceed personal credit limit. Limit: ZMW ${borrower.credit_limit.toFixed(2)}, Current owing: ZMW ${borrower.current_outstanding.toFixed(2)}, Available: ZMW ${(borrower.credit_limit - borrower.current_outstanding).toFixed(2)}.`);
    }

    const totalDaily = borrower.daily_borrowed_today + requestedAmount;
    daily_borrower_cap_passed = totalDaily <= settings.daily_borrower_limit;
    if (!daily_borrower_cap_passed) {
      reasons.push(`Loan would exceed daily borrowing limit of ZMW ${settings.daily_borrower_limit.toFixed(2)}.`);
    }
  }

  // 6. Safeguard 5: Live Gateway Phone Balance Check (Instapay Android App wallet)
  // Ensures physical SIM card has enough money + safety buffer before triggering USSD!
  const requiredWalletAmount = requestedAmount + settings.gateway_min_reserve_buffer;
  const gateway_balance_passed = gateway.balance >= requiredWalletAmount;
  if (!gateway_balance_passed) {
    reasons.push(`Insufficient funds on the Instapay dispensing phone. Wallet balance is ZMW ${gateway.balance.toFixed(2)}, but ZMW ${requiredWalletAmount.toFixed(2)} is required (including ZMW ${settings.gateway_min_reserve_buffer.toFixed(2)} safety reserve).`);
  }

  const gateway_status_passed = gateway.status !== 'offline';
  if (!gateway_status_passed) {
    reasons.push('Instapay Android dispensing phone is currently OFFLINE.');
  }

  const eligible = emergency_freeze_passed &&
    amount_range_passed &&
    government_cap_passed &&
    borrower_limit_passed &&
    daily_borrower_cap_passed &&
    gateway_balance_passed &&
    gateway_status_passed &&
    settings.auto_approval_enabled;

  return {
    eligible,
    reasons,
    borrower: {
      id: borrower.id,
      full_name: borrower.full_name,
      phone_number: borrower.phone_number,
      credit_limit: borrower.credit_limit,
      current_outstanding: borrower.current_outstanding,
      remaining_credit: Math.max(0, borrower.credit_limit - borrower.current_outstanding)
    },
    checks: {
      emergency_freeze_passed,
      amount_range_passed,
      government_cap_passed,
      borrower_limit_passed,
      daily_borrower_cap_passed,
      gateway_balance_passed,
      gateway_status_passed
    },
    limits: {
      requested_amount: requestedAmount,
      min_single_loan: settings.min_single_loan,
      max_single_loan: settings.max_single_loan,
      government_max_loan: settings.government_max_loan_limit,
      gateway_balance: gateway.balance,
      gateway_buffer: settings.gateway_min_reserve_buffer
    }
  };
}

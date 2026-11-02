import { inMemoryStore, supabase } from './supabaseClient';
import { Server as SocketIOServer } from 'socket.io';

export interface InterceptedPromptData {
  loanId: string;
  flowType: 'SEND_MONEY' | 'GET_CASH';
  rawText: string;
  recipientName?: string;
  recipientPhone?: string;
  agentNumber?: string;
  amount: number;
  transactionFee?: number;
}

export function parseUssdPrompt(rawText: string, flowType: 'SEND_MONEY' | 'GET_CASH'): Partial<InterceptedPromptData> {
  const text = rawText.trim();

  if (flowType === 'SEND_MONEY') {
    // Expected Airtel prompt:
    // "SEND Money to CHANDA MULENGA on 0977123456. Amount ZMW 150.00."
    const match = text.match(/SEND\s+Money\s+to\s+([A-Za-z\s]+?)\s+on\s+([0-9+]+)\.?\s*Amount\s*ZMW\s*([0-9.,]+)/i);
    if (match) {
      return {
        recipientName: match[1].trim(),
        recipientPhone: match[2].trim(),
        amount: parseFloat(match[3].replace(/,/g, ''))
      };
    }
    // Fallback regex if variations occur
    const nameMatch = text.match(/to\s+([A-Za-z\s]+?)\s+on/i);
    const phoneMatch = text.match(/on\s+([0-9+]+)/i);
    const amountMatch = text.match(/Amount\s*ZMW\s*([0-9.,]+)/i);
    return {
      recipientName: nameMatch ? nameMatch[1].trim() : 'Recipent Verified',
      recipientPhone: phoneMatch ? phoneMatch[1].trim() : '',
      amount: amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : 0
    };
  }

  if (flowType === 'GET_CASH') {
    // Expected Airtel prompt:
    // "WITHDRAW ZMW 500.00 from 492109 BWALYA KABWE transaction fee ZMW 12.50"
    const match = text.match(/WITHDRAW\s+ZMW\s*([0-9.,]+)\s+from\s+([0-9]+)\s+([A-Za-z\s]+?)\s+(?:transaction\s+fee|fee)\s*ZMW\s*([0-9.,]+)/i);
    if (match) {
      return {
        amount: parseFloat(match[1].replace(/,/g, '')),
        agentNumber: match[2].trim(),
        recipientName: match[3].trim(),
        transactionFee: parseFloat(match[4].replace(/,/g, ''))
      };
    }
    // Fallback regex
    const amountMatch = text.match(/WITHDRAW\s+ZMW\s*([0-9.,]+)/i);
    const agentMatch = text.match(/from\s+([0-9]+)\s+([A-Za-z\s]+)/i);
    const feeMatch = text.match(/(?:transaction\s+fee|fee)\s*ZMW\s*([0-9.,]+)/i);
    return {
      amount: amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : 0,
      agentNumber: agentMatch ? agentMatch[1].trim() : '',
      recipientName: agentMatch ? agentMatch[2].trim() : 'Agent Verified',
      transactionFee: feeMatch ? parseFloat(feeMatch[1].replace(/,/g, '')) : 0
    };
  }

  return {};
}

// Active sessions tracking timeouts
const activeTimers = new Map<string, NodeJS.Timeout>();

export function registerUssdSession(
  io: SocketIOServer,
  loanId: string,
  gatewayDeviceId: string,
  flowType: 'SEND_MONEY' | 'GET_CASH'
) {
  const session = {
    id: `ussd-${Date.now()}`,
    loan_id: loanId,
    gateway_device_id: gatewayDeviceId,
    flow_type: flowType,
    current_step: 'DIALING',
    step_history: [{ step: 'DIAL', time: new Date().toISOString() }],
    last_prompt_text: '*115#',
    status: 'ACTIVE',
    created_at: new Date().toISOString()
  };

  inMemoryStore.ussdSessions.set(loanId, session);
  return session;
}

export function handleUssdPromptIntercepted(
  io: SocketIOServer,
  payload: {
    loanId: string;
    rawText: string;
    stepName?: string;
  }
) {
  const loan = inMemoryStore.loans.get(payload.loanId);
  if (!loan) {
    console.warn('[USSD Coordinator] Received prompt for unknown loan:', payload.loanId);
    return;
  }

  const parsed = parseUssdPrompt(payload.rawText, loan.loan_type);
  const confirmationData = {
    loanId: loan.id,
    flowType: loan.loan_type,
    amount: parsed.amount || loan.amount,
    recipientName: parsed.recipientName || 'Verified Party',
    recipientPhone: parsed.recipientPhone || loan.recipient_phone,
    agentNumber: parsed.agentNumber || loan.agent_number,
    transactionFee: parsed.transactionFee || 0,
    rawText: payload.rawText,
    timeoutSeconds: 22
  };

  loan.status = 'AWAITING_CUSTOMER_CONFIRMATION';
  loan.parsed_recipient_name = confirmationData.recipientName;
  loan.parsed_ussd_details = confirmationData;
  loan.updated_at = new Date().toISOString();

  const session = inMemoryStore.ussdSessions.get(loan.id);
  if (session) {
    session.current_step = 'AWAITING_CONFIRMATION';
    session.last_prompt_text = payload.rawText;
    session.confirmation_payload = confirmationData;
    session.step_history.push({ step: 'PROMPT_INTERCEPTED', prompt: payload.rawText, time: new Date().toISOString() });
  }

  // Clear previous timer if any
  if (activeTimers.has(loan.id)) {
    clearTimeout(activeTimers.get(loan.id)!);
  }

  // Set safety auto-cancellation timer (USSD network will timeout on phone if no reply)
  const timer = setTimeout(() => {
    console.log(`[USSD Coordinator] Confirmation timeout for loan ${loan.id}. Auto-cancelling.`);
    handleCustomerResponse(io, loan.id, 'CANCEL', 'Timeout: No confirmation received within 22 seconds.');
  }, 22000);
  activeTimers.set(loan.id, timer);

  // Broadcast to Customer App and MFI Dashboard in Realtime!
  io.emit('ussd:confirmation_prompt', confirmationData);
  io.to(`loan:${loan.id}`).emit('ussd:confirmation_prompt', confirmationData);
  io.emit('mfi:loan_updated', loan);

  console.log(`[USSD Coordinator] Broadcast confirmation prompt for ${loan.id}: ${confirmationData.recipientName} (ZMW ${confirmationData.amount})`);
}

export function handleCustomerResponse(
  io: SocketIOServer,
  loanId: string,
  decision: 'CONFIRM' | 'CANCEL',
  reason?: string
) {
  if (activeTimers.has(loanId)) {
    clearTimeout(activeTimers.get(loanId)!);
    activeTimers.delete(loanId);
  }

  const loan = inMemoryStore.loans.get(loanId);
  if (!loan) return;

  const session = inMemoryStore.ussdSessions.get(loanId);

  if (decision === 'CONFIRM') {
    loan.status = 'CUSTOMER_CONFIRMED';
    loan.updated_at = new Date().toISOString();
    if (session) {
      session.customer_action = 'CONFIRM';
      session.current_step = 'SENDING_PIN';
      session.step_history.push({ step: 'CUSTOMER_CONFIRMED', time: new Date().toISOString() });
    }

    // Command the Android phone to enter the 4-digit PIN!
    io.emit('gateway:execute_command', {
      action: 'ENTER_PIN',
      loanId: loan.id,
      flowType: loan.loan_type
    });

    console.log(`[USSD Coordinator] Customer confirmed loan ${loan.id}. Instructing Android App to enter PIN.`);
  } else {
    loan.status = 'CUSTOMER_CANCELLED';
    loan.rejection_reason = reason || 'Customer cancelled on prompt.';
    loan.updated_at = new Date().toISOString();
    if (session) {
      session.customer_action = 'CANCEL';
      session.status = 'CANCELLED';
      session.step_history.push({ step: 'CUSTOMER_CANCELLED', reason, time: new Date().toISOString() });
    }

    // Command Android phone to click CANCEL on the USSD dialog!
    io.emit('gateway:execute_command', {
      action: 'CLICK_CANCEL',
      loanId: loan.id,
      flowType: loan.loan_type
    });

    inMemoryStore.gateway.status = 'idle';
    console.log(`[USSD Coordinator] Customer cancelled loan ${loan.id}. Instructing Android App to click Cancel.`);
  }

  io.emit('loan:status_changed', { loanId: loan.id, status: loan.status, loan });
  io.emit('mfi:loan_updated', loan);
}

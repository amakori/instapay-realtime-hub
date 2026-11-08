import express, { Request, Response } from 'express';
import http from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { inMemoryStore, supabase } from './supabaseClient';
import { evaluateInstaLoan } from './creditEngine';
import {
  handleUssdPromptIntercepted,
  handleCustomerResponse,
  registerUssdSession
} from './ussdCoordinator';
import { processIncomingCarrierSms } from './smsIngestion';
import { addFulfilmentSocketHandlers, createFulfilmentRouter } from './fulfilment';
import {
  getShippingOrders,
  getShippingOrderById,
  createShippingOrder,
  executeShippingPickup
} from './shippingService';
import {
  getCollateralPickups,
  getCollateralById,
  calculateCollateralValuation,
  createCollateralAppraisal,
  executeCollateralPickupAndActivateInstaPay
} from './collateralService';

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8080;

// CORS setup for both web apps (MFI Software & Customer App) and Android clients
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
app.use('/api/fulfilment', createFulfilmentRouter(io));
addFulfilmentSocketHandlers(io);

// Seed in-memory store with any historical data
const initialLoanId = 'b1111111-1111-1111-1111-111111111111';
inMemoryStore.loans.set(initialLoanId, {
  id: initialLoanId,
  borrower_id: 'a1111111-1111-1111-1111-111111111111',
  borrower_phone: '0978587412',
  borrower_name: 'Mwamba Chileshe',
  loan_type: 'SEND_MONEY',
  amount: 150.00,
  fee_amount: 3.50,
  recipient_phone: '0978112233',
  parsed_recipient_name: 'BRIAN BANDA',
  gateway_device_id: 'gateway-airtel-01',
  status: 'COMPLETED',
  carrier_sms_reference: 'TXN84910284',
  carrier_sms_text: 'Trans. ID: TXN84910284. You have sent ZMW 150.00 to BRIAN BANDA 0978112233 on 28/10/2026 10:14. Fee: ZMW 3.50. New balance: ZMW 8450.00.',
  created_at: new Date(Date.now() - 7200000).toISOString(),
  updated_at: new Date(Date.now() - 7100000).toISOString()
});

inMemoryStore.smsLogs.push({
  id: 'c1111111-1111-1111-1111-111111111111',
  gateway_device_id: 'gateway-airtel-01',
  sender: 'AirtelMoney',
  raw_sms: 'Trans. ID: TXN84910284. You have sent ZMW 150.00 to BRIAN BANDA 0978112233 on 28/10/2026 10:14. Fee: ZMW 3.50. New balance: ZMW 8450.00.',
  parsed_transaction_id: 'TXN84910284',
  parsed_amount: 150.00,
  parsed_recipient_or_agent: 'BRIAN BANDA (0978112233)',
  parsed_balance_after: 8450.00,
  matched_loan_id: initialLoanId,
  verified: true,
  created_at: new Date(Date.now() - 7200000).toISOString()
});

// ==========================================
// REST API ENDPOINTS
// ==========================================

// Health Check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'Instapay Realtime Hub',
    timestamp: new Date().toISOString(),
    gateway: {
      status: inMemoryStore.gateway.status,
      balance: inMemoryStore.gateway.balance,
      battery: inMemoryStore.gateway.battery_level
    }
  });
});

// MFI Software: Overview Stats
app.get('/api/mfi/overview', (req: Request, res: Response) => {
  const allLoans = Array.from(inMemoryStore.loans.values());
  const completedLoans = allLoans.filter(l => l.status === 'COMPLETED');
  const activeLoans = allLoans.filter(l => !['COMPLETED', 'FAILED', 'REJECTED', 'CUSTOMER_CANCELLED'].includes(l.status));
  
  const totalDisbursedToday = completedLoans.reduce((sum, l) => sum + Number(l.amount), 0);
  const totalFeesEarned = completedLoans.reduce((sum, l) => sum + Number(l.fee_amount || 0), 0);
  const shippingList = getShippingOrders();
  const collateralList = getCollateralPickups();

  res.json({
    gateway: inMemoryStore.gateway,
    settings: inMemoryStore.settings,
    stats: {
      totalLoansCount: allLoans.length,
      completedLoansCount: completedLoans.length,
      activeLoansCount: activeLoans.length,
      shippingOrdersCount: shippingList.length,
      activeShippingCount: shippingList.filter(s => s.status !== 'DELIVERED').length,
      collateralCount: collateralList.length,
      activeCollateralCount: collateralList.filter(c => c.status !== 'IN_MFI_VAULT').length,
      totalDisbursedToday,
      totalFeesEarned,
      approvalRate: allLoans.length > 0 ? ((completedLoans.length / allLoans.length) * 100).toFixed(1) : '100.0'
    },
    activeLoans: activeLoans.slice(0, 10),
    recentLoans: allLoans.slice(-10).reverse(),
    shippingOrders: shippingList.slice(0, 10),
    collateralPickups: collateralList.slice(0, 10)
  });
});

// MFI Software: List Loans
app.get('/api/mfi/loans', (req: Request, res: Response) => {
  const allLoans = Array.from(inMemoryStore.loans.values()).reverse();
  res.json(allLoans);
});

// MFI Software: List Borrowers
app.get('/api/mfi/borrowers', (req: Request, res: Response) => {
  res.json(inMemoryStore.borrowers);
});

// MFI Software: Safeguard Settings
app.get('/api/mfi/settings', (req: Request, res: Response) => {
  res.json(inMemoryStore.settings);
});

app.post('/api/mfi/settings', (req: Request, res: Response) => {
  const updates = req.body;
  inMemoryStore.settings = { ...inMemoryStore.settings, ...updates };
  io.emit('mfi:settings_updated', inMemoryStore.settings);
  console.log('[MFI Settings] Updated settings:', inMemoryStore.settings);
  res.json({ success: true, settings: inMemoryStore.settings });
});

// Gateway Device Status & Heartbeat
app.get('/api/gateway/status', (req: Request, res: Response) => {
  res.json(inMemoryStore.gateway);
});

app.post('/api/gateway/heartbeat', (req: Request, res: Response) => {
  const { battery_level, balance, status } = req.body;
  if (battery_level !== undefined) inMemoryStore.gateway.battery_level = Number(battery_level);
  if (balance !== undefined) inMemoryStore.gateway.balance = Number(balance);
  if (status !== undefined) inMemoryStore.gateway.status = status;
  inMemoryStore.gateway.last_heartbeat = new Date().toISOString();

  io.emit('gateway:heartbeat', inMemoryStore.gateway);
  res.json({ success: true, gateway: inMemoryStore.gateway });
});

// Credit Evaluation & Loan Request
app.post('/api/loan/evaluate', async (req: Request, res: Response) => {
  const { borrower_phone, amount, loan_type } = req.body;
  const result = await evaluateInstaLoan(borrower_phone, Number(amount), loan_type);
  res.json(result);
});

// Customer submits Loan Application
app.post('/api/loan/apply', async (req: Request, res: Response) => {
  const { borrower_phone, borrower_name, amount, loan_type, recipient_phone, agent_number } = req.body;

  if (!borrower_phone || !amount || !loan_type) {
    return res.status(400).json({ error: 'Missing required loan fields.' });
  }

  const requestedAmount = Number(amount);
  const evaluation = await evaluateInstaLoan(borrower_phone, requestedAmount, loan_type);

  const loanId = uuidv4();
  const newLoan = {
    id: loanId,
    borrower_id: evaluation.borrower?.id,
    borrower_phone,
    borrower_name: borrower_name || evaluation.borrower?.full_name || 'Borrower',
    loan_type,
    amount: requestedAmount,
    fee_amount: loan_type === 'GET_CASH' ? 12.50 : 3.50,
    recipient_phone: loan_type === 'SEND_MONEY' ? recipient_phone : null,
    agent_number: loan_type === 'GET_CASH' ? agent_number : null,
    parsed_recipient_name: null,
    gateway_device_id: inMemoryStore.gateway.id,
    status: evaluation.eligible ? 'APPROVED' : 'REJECTED',
    rejection_reason: evaluation.eligible ? null : evaluation.reasons.join(' | '),
    credit_decision_details: evaluation,
    parsed_ussd_details: {},
    carrier_sms_reference: null,
    carrier_sms_text: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  inMemoryStore.loans.set(loanId, newLoan);

  // Broadcast to MFI Software
  io.emit('mfi:loan_created', newLoan);

  if (!evaluation.eligible) {
    return res.status(422).json({
      success: false,
      message: 'Loan request declined by MFI credit and safeguard rules.',
      loan: newLoan,
      evaluation
    });
  }

  // Loan is Approved! Mark gateway as busy and dispatch USSD command to Android app
  inMemoryStore.gateway.status = 'busy';
  newLoan.status = 'DISPATCHED';

  const session = registerUssdSession(io, loanId, inMemoryStore.gateway.id, loan_type);

  // Emit dispatch command to Android App
  const dispatchPayload = {
    command: loan_type === 'SEND_MONEY' ? 'DISPATCH_SEND_MONEY' : 'DISPATCH_GET_CASH',
    loanId: newLoan.id,
    amount: newLoan.amount,
    recipientPhone: newLoan.recipient_phone,
    agentNumber: newLoan.agent_number,
    ussdCode: '*115#'
  };

  io.emit('gateway:dispatch_ussd', dispatchPayload);
  io.emit('mfi:gateway_updated', inMemoryStore.gateway);

  console.log(`[Loan Application] Approved loan ${loanId} for ${borrower_phone} (ZMW ${requestedAmount}). Dispatched to Android Gateway.`);

  res.json({
    success: true,
    message: 'Loan approved and dispatched to Instapay Android App for USSD execution.',
    loan: newLoan,
    evaluation
  });
});

// Incoming SMS endpoint (called by Android App Retrofit or SMS Receiver)
app.post('/api/sms/incoming', async (req: Request, res: Response) => {
  const { raw_sms, gateway_id } = req.body;
  if (!raw_sms) {
    return res.status(400).json({ error: 'Missing raw_sms body.' });
  }

  const result = await processIncomingCarrierSms(raw_sms, gateway_id || inMemoryStore.gateway.id);
  io.emit('carrier:sms_received', result);
  io.emit('mfi:gateway_updated', inMemoryStore.gateway);

  res.json({ success: true, ...result });
});

// Carrier SMS Feed
app.get('/api/mfi/sms-logs', (req: Request, res: Response) => {
  res.json(inMemoryStore.smsLogs);
});

// Customer Confirm / Cancel API endpoint (in addition to WebSockets)
app.post('/api/loan/confirm-prompt', (req: Request, res: Response) => {
  const { loanId, decision, reason } = req.body;
  if (!loanId || !decision) {
    return res.status(400).json({ error: 'Missing loanId or decision.' });
  }

  handleCustomerResponse(io, loanId, decision, reason);
  const loan = inMemoryStore.loans.get(loanId);
  res.json({ success: true, loan });
});

// ==========================================
// SHIPPING PICKUP API ENDPOINTS
// ==========================================
app.get('/api/shipping/orders', (req: Request, res: Response) => {
  const mode = req.query.mode as string | undefined;
  res.json(getShippingOrders(mode));
});

app.get('/api/shipping/orders/:id', (req: Request, res: Response) => {
  const order = getShippingOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

app.post('/api/shipping/orders', (req: Request, res: Response) => {
  const order = createShippingOrder(req.body);
  io.emit('shipping:order_created', order);
  res.json({ success: true, order });
});

app.post('/api/shipping/orders/:id/pickup', (req: Request, res: Response) => {
  try {
    const order = executeShippingPickup(io, req.params.id, req.body);
    res.json({ success: true, order });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// COLLATERAL PICKUP & INSTAPAY ACTIVATION ENDPOINTS
// ==========================================
app.get('/api/collateral/pickups', (req: Request, res: Response) => {
  res.json(getCollateralPickups());
});

app.get('/api/collateral/pickups/:id', (req: Request, res: Response) => {
  const item = getCollateralById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Collateral item not found' });
  res.json(item);
});

app.post('/api/collateral/valuate', (req: Request, res: Response) => {
  try {
    const valuation = calculateCollateralValuation(req.body);
    res.json({ success: true, ...valuation });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/collateral/appraisal', (req: Request, res: Response) => {
  try {
    const item = createCollateralAppraisal(req.body);
    io.emit('collateral:created', item);
    res.json({ success: true, item });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/collateral/pickups/:id/pickup', (req: Request, res: Response) => {
  try {
    const result = executeCollateralPickupAndActivateInstaPay(io, req.params.id, req.body);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// FULL END-TO-END SIMULATION RUNNER
// ==========================================
// Allows verifying the whole system even when physical Android hardware is in staging!
app.post('/api/simulate/run-flow', async (req: Request, res: Response) => {
  const { loan_type, amount, recipient_phone, agent_number } = req.body;
  const targetType = loan_type === 'GET_CASH' ? 'GET_CASH' : 'SEND_MONEY';
  const targetAmount = Number(amount) || (targetType === 'GET_CASH' ? 500 : 150);
  const targetRecipient = recipient_phone || '0977123456';
  const targetAgent = agent_number || '492109';

  console.log(`[Simulator] Starting automated simulation of ${targetType} (ZMW ${targetAmount})...`);

  // 1. Create and evaluate loan
  const loanId = uuidv4();
  const evaluation = await evaluateInstaLoan('0977123456', targetAmount, targetType);

  const loan = {
    id: loanId,
    borrower_id: 'a2222222-2222-2222-2222-222222222222',
    borrower_phone: '0977123456',
    borrower_name: 'Natasha Tembo',
    loan_type: targetType,
    amount: targetAmount,
    fee_amount: targetType === 'GET_CASH' ? 12.50 : 3.50,
    recipient_phone: targetType === 'SEND_MONEY' ? targetRecipient : null,
    agent_number: targetType === 'GET_CASH' ? targetAgent : null,
    parsed_recipient_name: null,
    gateway_device_id: inMemoryStore.gateway.id,
    status: 'USSD_IN_PROGRESS',
    credit_decision_details: evaluation,
    parsed_ussd_details: {},
    carrier_sms_reference: null,
    carrier_sms_text: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  inMemoryStore.loans.set(loanId, loan);
  inMemoryStore.gateway.status = 'busy';
  registerUssdSession(io, loanId, inMemoryStore.gateway.id, targetType);

  io.emit('mfi:loan_created', loan);
  io.emit('mfi:gateway_updated', inMemoryStore.gateway);

  // 2. Simulate USSD Dialing & Step Navigation in Android App
  setTimeout(() => {
    io.emit('gateway:ussd_step', { loanId, step: 1, action: 'Dial *115#' });
  }, 500);

  setTimeout(() => {
    io.emit('gateway:ussd_step', {
      loanId,
      step: 2,
      action: targetType === 'SEND_MONEY' ? 'Enter 1 -> 1 -> 1' : 'Enter 2 -> 1'
    });
  }, 1200);

  setTimeout(() => {
    io.emit('gateway:ussd_step', {
      loanId,
      step: 3,
      action: targetType === 'SEND_MONEY' ? `Enter Phone ${targetRecipient}` : `Enter Amount ${targetAmount}`
    });
  }, 1900);

  // 3. Android App intercepts the USSD Confirmation Screen!
  setTimeout(() => {
    let mockPrompt = '';
    if (targetType === 'SEND_MONEY') {
      mockPrompt = `SEND Money to CHANDA MULENGA on ${targetRecipient}. Amount ZMW ${targetAmount.toFixed(2)}.`;
    } else {
      mockPrompt = `WITHDRAW ZMW ${targetAmount.toFixed(2)} from ${targetAgent} BWALYA KABWE transaction fee ZMW 12.50`;
    }

    console.log(`[Simulator] Android App intercepted USSD Prompt: "${mockPrompt}"`);
    handleUssdPromptIntercepted(io, {
      loanId,
      rawText: mockPrompt
    });
  }, 2600);

  res.json({
    success: true,
    message: 'Simulation initiated. USSD prompt intercepted and awaiting confirmation.',
    loanId,
    loan
  });
});

// ==========================================
// SOCKET.IO REALTIME HANDLERS
// ==========================================
io.on('connection', (socket: Socket) => {
  console.log('[Socket] Client connected:', socket.id);

  // Join room for specific loan tracking
  socket.on('loan:subscribe', (loanId: string) => {
    socket.join(`loan:${loanId}`);
    console.log(`[Socket] ${socket.id} subscribed to loan:${loanId}`);
  });

  // Android Gateway phone registers
  socket.on('gateway:register', (data: any) => {
    inMemoryStore.gateway.status = 'idle';
    if (data?.battery) inMemoryStore.gateway.battery_level = data.battery;
    if (data?.balance) inMemoryStore.gateway.balance = data.balance;
    io.emit('mfi:gateway_updated', inMemoryStore.gateway);
    console.log('[Gateway] Android device registered:', data);
  });

  // Android App reports step updates
  socket.on('gateway:ussd_step_update', (data: any) => {
    io.emit('mfi:ussd_step', data);
    const session = inMemoryStore.ussdSessions.get(data.loanId);
    if (session) {
      session.current_step = data.stepName || `STEP_${data.step}`;
      session.step_history.push({ step: data.stepName, time: new Date().toISOString() });
    }
  });

  // Android App Accessibility Service reports USSD prompt intercepted!
  socket.on('gateway:ussd_prompt_intercepted', (data: { loanId: string; rawText: string }) => {
    console.log('[Gateway] USSD Prompt Intercepted from Android:', data);
    handleUssdPromptIntercepted(io, data);
  });

  // Borrower responds from Customer App (Confirm or Cancel)
  socket.on('customer:confirm_prompt', (data: { loanId: string; decision: 'CONFIRM' | 'CANCEL'; reason?: string }) => {
    console.log('[Customer App] Confirmation response:', data);
    handleCustomerResponse(io, data.loanId, data.decision, data.reason);
  });

  // Android App SMS Receiver reports incoming SMS
  socket.on('gateway:sms_received', async (data: { rawSms: string; gatewayId?: string }) => {
    console.log('[Gateway] Incoming SMS from Android App:', data);
    const result = await processIncomingCarrierSms(data.rawSms, data.gatewayId || inMemoryStore.gateway.id);
    io.emit('carrier:sms_received', result);
    io.emit('mfi:gateway_updated', inMemoryStore.gateway);
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Client disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Instapay Realtime Hub running on port ${PORT}`);
  console.log(` Health endpoint: http://localhost:${PORT}/health`);
  console.log(` Gateway Status: ${inMemoryStore.gateway.status} | Balance: ZMW ${inMemoryStore.gateway.balance}`);
  console.log(`====================================================`);
});

/**
 * Plan Guard Pro — Stripe Checkout Server
 * 
 * Simple Express server for Stripe Checkout Sessions.
 * Use this when ready to move beyond Payment Links to a full integration.
 * 
 * Setup:
 *   1. npm init -y
 *   2. npm install express stripe cors dotenv
 *   3. Create .env file with your keys (see below)
 *   4. node stripe-server.js
 * 
 * Required .env:
 *   STRIPE_SECRET_KEY=sk_live_your_secret_key
 *   STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
 *   DOMAIN=https://planguardpro.com
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const DOMAIN = process.env.DOMAIN || 'https://planguardpro.com';

// ─── Stripe Product Configuration ───
// For sheet-based pricing, you have two approaches:
//
// APPROACH 1 (Recommended for manual phase): Stripe Invoicing
//   - Customer submits intake form with sheet count
//   - You calculate exact price and create a Stripe Invoice
//   - Customer pays → you begin review
//   - No products/prices needed upfront
//
// APPROACH 2 (API phase): Dynamic Checkout Sessions
//   - Calculate price server-side from sheet count
//   - Create ad-hoc line items (no pre-created products needed)
//
// Pricing formula: $249 base + $25/sheet (first 30) + $20/sheet (31+)
// Calc add-on: +$150

const PRICING = {
  base: 249,
  perSheet1: 25,      // sheets 1–30
  perSheet2: 20,      // sheets 31+
  threshold: 30,
  calcAddon: 150,
};

function calculatePrice(sheets, includeCalc = false) {
  const tier1 = Math.min(sheets, PRICING.threshold);
  const tier2 = Math.max(0, sheets - PRICING.threshold);
  return PRICING.base + (tier1 * PRICING.perSheet1) + (tier2 * PRICING.perSheet2) + (includeCalc ? PRICING.calcAddon : 0);
}

// ─── Middleware ───
app.use(cors({ origin: DOMAIN }));

// Raw body for webhook signature verification (must be before express.json())
app.post('/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// JSON body for all other routes
app.use(express.json());

// ─── Create Checkout Session ───
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { sheets, includeCalc, facilityName, hcaiAppNumber } = req.body;

    const sheetCount = Math.min(Math.max(parseInt(sheets) || 1, 1), 100);
    const total = calculatePrice(sheetCount, includeCalc);

    // Build line items dynamically
    const lineItems = [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `HCAI Pre-Submission Screening — ${sheetCount} Sheets`,
            description: `Base fee + ${sheetCount} sheet${sheetCount > 1 ? 's' : ''} screening`,
          },
          unit_amount: (total - (includeCalc ? PRICING.calcAddon : 0)) * 100,
        },
        quantity: 1,
      },
    ];

    if (includeCalc) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Structural Calc Review Add-On',
            description: 'Load path verification, seismic parameter check',
          },
          unit_amount: PRICING.calcAddon * 100,
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',

      // Collect customer info
      customer_creation: 'always',
      billing_address_collection: 'required',

      // Custom fields to collect project details
      custom_fields: [
        {
          key: 'facility_name',
          label: { type: 'custom', custom: 'Facility Name' },
          type: 'text',
          optional: false,
        },
        {
          key: 'hcai_app_number',
          label: { type: 'custom', custom: 'HCAI Application Number (if available)' },
          type: 'text',
          optional: true,
        },
      ],

      // Metadata for your records
      metadata: {
        sheet_count: String(sheetCount),
        includes_calc: includeCalc ? 'yes' : 'no',
        total_price: String(total),
        facility_name: facilityName || '',
        hcai_app_number: hcaiAppNumber || '',
      },

      // Redirect URLs
      success_url: `${DOMAIN}/thank-you?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${DOMAIN}/#pricing`,

      // Receipt
      payment_intent_data: {
        receipt_email: undefined, // Stripe collects email and sends receipt
      },
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error('Checkout session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhook Handler ───
// Set up in Stripe Dashboard → Developers → Webhooks → Add endpoint
// URL: https://planguardpro.com/webhook
// Events: checkout.session.completed, payment_intent.succeeded
async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      console.log('─── NEW ORDER ───');
      console.log('Customer:', session.customer_details?.email);
      console.log('Sheets:', session.metadata?.sheet_count);
      console.log('Calc Add-On:', session.metadata?.includes_calc);
      console.log('Facility:', session.metadata?.facility_name);
      console.log('HCAI App#:', session.metadata?.hcai_app_number);
      console.log('Amount:', (session.amount_total / 100).toFixed(2), session.currency?.toUpperCase());
      console.log('Payment ID:', session.payment_intent);
      console.log('─────────────────');

      // TODO: Send notification email to yourself
      // TODO: Create order record in your database
      // TODO: Send confirmation email to customer with upload instructions

      // For now, Stripe sends a payment receipt automatically.
      // You'll see the order in your Stripe Dashboard → Payments
      break;
    }

    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object;
      console.log('Payment succeeded:', paymentIntent.id);
      break;
    }

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
}

// ─── Retrieve session (for thank-you page) ───
app.get('/api/checkout-session/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    res.json({
      customerEmail: session.customer_details?.email,
      sheetCount: session.metadata?.sheet_count,
      includesCalc: session.metadata?.includes_calc,
      facilityName: session.metadata?.facility_name,
      status: session.payment_status,
    });
  } catch (err) {
    res.status(404).json({ error: 'Session not found' });
  }
});

// ─── Health check ───
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'planguardpro-stripe' });
});

// ─── Start ───
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Plan Guard Pro Stripe server running on port ${PORT}`);
  console.log(`Webhook endpoint: ${DOMAIN}/webhook`);
});

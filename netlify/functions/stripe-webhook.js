const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  };
}

function normaliseCouponCode(code) {
  return String(code || "").trim().toUpperCase();
}

async function getCouponStore() {
  const { getStore } = await import("@netlify/blobs");
  return getStore("leemah-coupon-usage");
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return jsonResponse(500, { error: "Stripe webhook is not configured." });
  }

  let stripeEvent;

  try {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
    const signature = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];

    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error("Webhook signature verification failed.", error);
    return jsonResponse(400, { error: "Webhook signature verification failed." });
  }

  if (stripeEvent.type !== "checkout.session.completed") {
    return jsonResponse(200, { received: true });
  }

  const session = stripeEvent.data.object;
  const metadata = session.metadata || {};
  const couponCode = normaliseCouponCode(metadata.coupon_code);

  if (!couponCode || couponCode === "NONE" || metadata.coupon_type !== "local_coupon") {
    return jsonResponse(200, { received: true });
  }

  if (session.payment_status && session.payment_status !== "paid") {
    return jsonResponse(200, { received: true });
  }

  try {
    const store = await getCouponStore();
    const key = `${couponCode}.json`;
    const usage = await store.get(key, { type: "json" }) || { paidSessions: [] };
    const paidSessions = Array.isArray(usage.paidSessions) ? usage.paidSessions : [];

    if (!paidSessions.includes(session.id)) {
      paidSessions.push(session.id);
      await store.setJSON(key, {
        paidSessions,
        lastRedeemedAt: new Date().toISOString()
      });
    }

    return jsonResponse(200, { received: true });
  } catch (error) {
    console.error("Could not record coupon redemption.", error);
    return jsonResponse(500, { error: "Could not record coupon redemption." });
  }
};

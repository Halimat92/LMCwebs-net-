const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const CURRENCY = "gbp";
const BUSINESS_NAME = "Leemah Cakes n More";

const CATALOGUE = {
  "red-velvet": { name: "Rouge Velvet Cake Jar", price: 728, jarCount: 1 },
  "vanilla-cake": { name: "Ivory Dream Cake Jar", price: 728, jarCount: 1 },
  "chocolate-caramel": { name: "Caramel Noir Cake Jar", price: 728, jarCount: 1 },
  "strawberry-bliss": { name: "Strawberry Bliss Cake Jar", price: 728, jarCount: 1 },
  "cookies-cream-noir": { name: "Cookies & Cream Noir Cake Jar", price: 728, jarCount: 1 },
  "bundle-trio": { name: "The Trio Bundle", price: 2184, jarCount: 3 },
  "bundle-four": { name: "The Four Pack Bundle", price: 2912, jarCount: 4 },
  "bundle-five": { name: "The Five Pack Bundle", price: 3550, jarCount: 5 }
};

const DELIVERY_LABELS = {
  pickup: "Pickup",
  second: "Standard Delivery",
  first: "Special Delivery"
};

const PICKUP_THANK_YOU_MESSAGE = "Thank you for ordering from Leemah Cakes & More! Your order will be freshly prepared with care. We'll notify you by text or email once your order is ready for collection, along with the pickup address and details. Please note: as every jar is made fresh to order, cancellations requested more than 6 hours after placing your order are non-refundable. We appreciate your understanding!";

const DELIVERY_THANK_YOU_MESSAGE = "Thank you for ordering from Leemah Cakes & More! Your order will be freshly prepared with care. Once your order is ready and collected by our courier, we'll send you a tracking number by text or email so you can follow your delivery. Please note: as every jar is made fresh to order, cancellations requested more than 6 hours after placing your order are non-refundable. We appreciate your understanding!";

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  };
}

function parseCouponJson(envName) {
  if (!process.env[envName]) return {};

  try {
    return JSON.parse(process.env[envName]);
  } catch (error) {
    console.error(`${envName} is not valid JSON.`, error);
    return {};
  }
}

function getAllowedCoupons() {
  return parseCouponJson("STRIPE_COUPONS_JSON");
}

function getLocalCoupons() {
  const configuredCoupons = parseCouponJson("LOCAL_COUPONS_JSON");
  const leemah5MaxUses = Number.parseInt(process.env.LEEMAH5_MAX_USES || "10", 10);

  return {
    LEEMAH5: {
      percent_off: 5,
      max_redemptions: Number.isInteger(leemah5MaxUses) && leemah5MaxUses > 0 ? leemah5MaxUses : 10,
      name: "LEEMAH5 discount"
    },
    ...configuredCoupons
  };
}

function getSiteUrl(event) {
  const origin = event.headers.origin || event.headers.Origin;
  return origin || process.env.URL || "https://shimmering-sprite-ef7deb.netlify.app";
}

function normaliseCouponCode(code) {
  return String(code || "").trim().toUpperCase();
}

function getDeliveryAmount(fulfilmentOption, totalJars) {
  if (fulfilmentOption === "pickup" || totalJars <= 0) return 0;
  if (fulfilmentOption === "second") return 499;
  if (fulfilmentOption === "first") return 1199;
  return 0;
}

function getEstimatedWeightKg(totalJars) {
  if (totalJars <= 0) return 0;
  if (totalJars <= 2) return 0.7;
  if (totalJars === 3) return 1.05;
  if (totalJars === 4) return 1.4;
  if (totalJars <= 6) return 2.1;
  return Math.ceil(totalJars / 2) * 0.7;
}

function getReceiptDescription(fulfilmentOption, orderSummary) {
  const nextStepMessage = fulfilmentOption === "pickup" ? PICKUP_THANK_YOU_MESSAGE : DELIVERY_THANK_YOU_MESSAGE;

  return `${BUSINESS_NAME} order: ${orderSummary}. ${nextStepMessage}`;
}

async function getCouponStore() {
  const { getStore } = await import("@netlify/blobs");
  return getStore("leemah-coupon-usage");
}

async function getCouponUsage(normalisedCode) {
  try {
    const store = await getCouponStore();
    const usage = await store.get(`${normalisedCode}.json`, { type: "json" });
    return usage || { paidSessions: [] };
  } catch (error) {
    console.error("Could not read coupon usage.", error);
    throw new Error("Coupon code could not be checked. Please try again.");
  }
}

function getRedeemedCount(usage) {
  return Array.isArray(usage.paidSessions) ? usage.paidSessions.length : 0;
}

function calculateDiscountAmount(coupon, productSubtotal) {
  if (typeof coupon.percent_off === "number") {
    return Math.round(productSubtotal * (coupon.percent_off / 100));
  }

  if (typeof coupon.amount_off === "number") {
    return Math.round(coupon.amount_off);
  }

  throw new Error("That coupon code is not configured correctly.");
}

async function calculateProductDiscount(couponCode, productSubtotal) {
  const normalisedCode = normaliseCouponCode(couponCode);
  if (!normalisedCode || productSubtotal <= 0) return null;

  const localCoupon = getLocalCoupons()[normalisedCode];
  if (localCoupon) {
    const maxRedemptions = Number.parseInt(localCoupon.max_redemptions, 10);
    const usage = await getCouponUsage(normalisedCode);
    const redeemedCount = getRedeemedCount(usage);

    if (Number.isInteger(maxRedemptions) && maxRedemptions > 0 && redeemedCount >= maxRedemptions) {
      throw new Error("That coupon code is expired.");
    }

    let amount = calculateDiscountAmount(localCoupon, productSubtotal);
    amount = Math.max(0, Math.min(amount, productSubtotal));

    if (amount <= 0) return null;

    return {
      type: "local_coupon",
      code: normalisedCode,
      amount,
      name: localCoupon.name || `${normalisedCode} discount`
    };
  }

  const coupon = getAllowedCoupons()[normalisedCode];
  if (!coupon) {
    throw new Error("That coupon code is not valid.");
  }

  let amount = calculateDiscountAmount(coupon, productSubtotal);
  amount = Math.max(0, Math.min(amount, productSubtotal));

  if (amount <= 0) return null;

  return {
    type: "generated_coupon",
    code: normalisedCode,
    amount,
    name: coupon.name || `${normalisedCode} discount`
  };
}

function buildOrder(payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) throw new Error("Your cart is empty.");

  const lineItems = [];
  const orderSummaryParts = [];
  let totalJars = 0;
  let productSubtotal = 0;

  for (const item of items) {
    const catalogueItem = CATALOGUE[item.id];
    const quantity = Number.parseInt(item.quantity, 10);

    if (!catalogueItem || !Number.isInteger(quantity) || quantity <= 0 || quantity > 30) {
      throw new Error("One of the cart items is not valid.");
    }

    totalJars += catalogueItem.jarCount * quantity;
    productSubtotal += catalogueItem.price * quantity;
    orderSummaryParts.push(`${quantity} x ${catalogueItem.name}`);

    lineItems.push({
      quantity,
      price_data: {
        currency: CURRENCY,
        unit_amount: catalogueItem.price,
        product_data: {
          name: catalogueItem.name,
          metadata: {
            jar_count: String(catalogueItem.jarCount)
          }
        }
      }
    });
  }

  if (totalJars < 2) {
    throw new Error("Minimum order is 2 jars.");
  }

  return { lineItems, totalJars, productSubtotal, orderSummary: orderSummaryParts.join("; ") };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return jsonResponse(500, { error: "Stripe secret key has not been added in Netlify." });
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    const fulfilmentOption = ["pickup", "second", "first"].includes(payload.fulfilmentOption)
      ? payload.fulfilmentOption
      : "pickup";
    const customer = payload.customer || {};
    const customerEmail = String(customer.email || "").trim();
    const customerName = String(customer.name || "").trim();
    const customerPhone = String(customer.phone || "").trim();
    const siteUrl = getSiteUrl(event);

    if (!customerEmail || !customerName || !customerPhone) {
      throw new Error("Please enter your name, email and phone number.");
    }

    if (fulfilmentOption !== "pickup") {
      if (!customer.address || !customer.city || !customer.postcode) {
        throw new Error("Please enter your delivery address, city and postcode.");
      }
    }

    const order = buildOrder(payload);
    const deliveryAmount = getDeliveryAmount(fulfilmentOption, order.totalJars);
    const estimatedWeightKg = getEstimatedWeightKg(order.totalJars);
    const discount = await calculateProductDiscount(payload.couponCode, order.productSubtotal);
    const deliveryLabel = DELIVERY_LABELS[fulfilmentOption];
    const orderNote = String(payload.orderNote || "").slice(0, 450);
    const addressText = fulfilmentOption === "pickup"
      ? "Pickup order"
      : `${customer.address}, ${customer.city}, ${customer.postcode}`;
    const orderSummary = order.orderSummary.slice(0, 500);
    const sharedMetadata = {
      order_summary: orderSummary,
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone,
      fulfilment: deliveryLabel,
      total_jars: String(order.totalJars),
      estimated_weight_kg: String(estimatedWeightKg),
      delivery_address: addressText,
      order_note: orderNote || "None",
      coupon_code: discount ? discount.code : "None",
      product_discount_pence: discount && discount.amount ? String(discount.amount) : "0",
      coupon_type: discount ? discount.type : "None"
    };

    const lineItems = [...order.lineItems];

    if (deliveryAmount > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: deliveryAmount,
          product_data: {
            name: deliveryLabel
          }
        }
      });
    }

    const sessionParams = {
      mode: "payment",
      line_items: lineItems,
      customer_email: customerEmail,
      client_reference_id: `${Date.now()}-${customerEmail}`,
      success_url: `${siteUrl}/?payment=success`,
      cancel_url: `${siteUrl}/?payment=cancelled`,
      metadata: sharedMetadata,
      payment_intent_data: {
        receipt_email: customerEmail,
        description: getReceiptDescription(fulfilmentOption, orderSummary),
        metadata: sharedMetadata
      },
      custom_text: {
        submit: {
          message: "Orders are prepared fresh. Orders cancelled after 6 hours are non-refundable."
        },
        after_submit: {
          message: fulfilmentOption === "pickup" ? PICKUP_THANK_YOU_MESSAGE : DELIVERY_THANK_YOU_MESSAGE
        }
      }
    };

    if (discount) {
      const stripeCoupon = await stripe.coupons.create({
        name: discount.name,
        amount_off: discount.amount,
        currency: CURRENCY,
        duration: "once",
        metadata: {
          entered_code: discount.code,
          product_only_discount: "true",
          coupon_type: discount.type
        }
      });

      sessionParams.discounts = [{ coupon: stripeCoupon.id }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return jsonResponse(200, { url: session.url });
  } catch (error) {
    console.error("Checkout error:", error);
    return jsonResponse(400, {
      error: error.message || "Checkout could not be created."
    });
  }
};



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
  "bundle-trio": { name: "The Trio Bundle", price: 2037, jarCount: 3 },
  "bundle-four": { name: "The Four Pack Bundle", price: 2715, jarCount: 4 },
  "bundle-six": { name: "The Six Pack Bundle", price: 3245, jarCount: 6 }
};

const DELIVERY_LABELS = {
  pickup: "Pickup",
  second: "2nd Class delivery",
  first: "1st Class delivery"
};

const PICKUP_THANK_YOU_MESSAGE = "Thank you for ordering from Leemah Cakes & More! Your order will be freshly prepared with care. We will notify you once your order is ready for pickup and share the pickup details/address with you. As every jar is made to order, cancellations requested more than 6 hours after placing your order are non-refundable. We appreciate your understanding!";

const DELIVERY_THANK_YOU_MESSAGE = "Thank you for ordering from Leemah Cakes & More! Your order will be freshly prepared with care and shipped within 24-48 hours. You will receive a tracking number once it is on its way. As every jar is made to order, cancellations requested more than 6 hours after placing your order are non-refundable. We appreciate your understanding!";

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  };
}

function getAllowedCoupons() {
  if (!process.env.STRIPE_COUPONS_JSON) return {};

  try {
    return JSON.parse(process.env.STRIPE_COUPONS_JSON);
  } catch (error) {
    console.error("STRIPE_COUPONS_JSON is not valid JSON.", error);
    return {};
  }
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

  if (fulfilmentOption === "second") {
    if (totalJars <= 2) return 349;
    if (totalJars <= 5) return 449;
    return 549;
  }

  if (fulfilmentOption === "first") {
    if (totalJars <= 2) return 499;
    if (totalJars <= 5) return 599;
    return 699;
  }

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

function calculateProductDiscount(couponCode, productSubtotal) {
  const normalisedCode = normaliseCouponCode(couponCode);
  if (!normalisedCode || productSubtotal <= 0) return null;

  const coupon = getAllowedCoupons()[normalisedCode];
  if (!coupon) {
    throw new Error("That coupon code is not valid.");
  }

  let amount = 0;

  if (typeof coupon.percent_off === "number") {
    amount = Math.round(productSubtotal * (coupon.percent_off / 100));
  } else if (typeof coupon.amount_off === "number") {
    amount = Math.round(coupon.amount_off);
  } else {
    throw new Error("That coupon code is not configured correctly.");
  }

  amount = Math.max(0, Math.min(amount, productSubtotal));

  if (amount <= 0) return null;

  return {
    code: normalisedCode,
    amount,
    name: coupon.name || `${normalisedCode} discount`
  };
}

function buildOrder(payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) throw new Error("Your cart is empty.");

  const lineItems = [];
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

  return { lineItems, totalJars, productSubtotal };
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
    const discount = calculateProductDiscount(payload.couponCode, order.productSubtotal);
    const deliveryLabel = DELIVERY_LABELS[fulfilmentOption];
    const orderNote = String(payload.orderNote || "").slice(0, 450);
    const addressText = fulfilmentOption === "pickup"
      ? "Pickup order"
      : `${customer.address}, ${customer.city}, ${customer.postcode}`;

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
      metadata: {
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,
        fulfilment: deliveryLabel,
        total_jars: String(order.totalJars),
        estimated_weight_kg: String(estimatedWeightKg),
        delivery_address: addressText,
        order_note: orderNote || "None",
        coupon_code: discount ? discount.code : "None",
        product_discount_pence: discount ? String(discount.amount) : "0"
      },
      payment_intent_data: {
        receipt_email: customerEmail,
        description: fulfilmentOption === "pickup" ? PICKUP_THANK_YOU_MESSAGE : DELIVERY_THANK_YOU_MESSAGE
      },
      custom_text: {
        submit: {
          message: "Orders are prepared fresh. Orders cancelled after 6 hours may not be refundable."
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
          product_only_discount: "true"
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

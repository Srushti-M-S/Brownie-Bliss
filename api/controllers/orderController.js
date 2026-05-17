const Order = require('../models/Order');
const Product = require('../models/Product');

function generateOrderId() {
  const date = new Date();
  const datePart = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `BB-${datePart}-${rand}`;
}

/**
 * Resolves the authoritative unit price for a single cart item from the Products collection.
 *
 * Standard items  → matched by numeric id_ref
 * Birthday cakes  → matched by string id_ref (flavor name), then scaled by weight
 *
 * Returns { resolvedPrice, product } or throws an error with a user-facing message.
 */
async function resolveItemPrice(item) {
  // Birthday cake: id is "bday-<Flavor>-<Weight>kg" e.g. "bday-Red Velvet-1.0"
  const birthdayMatch = String(item.id || '').match(/^bday-(.+)-(\d+(?:\.\d+)?)$/);

  if (birthdayMatch) {
    const flavor = birthdayMatch[1];             // e.g. "Red Velvet"
    const weight = parseFloat(birthdayMatch[2]); // e.g. 1.0

    if (isNaN(weight) || weight <= 0) {
      throw new Error(`Invalid weight for birthday cake: ${item.name}`);
    }

    const product = await Product.findOne({ type: 'birthday', id_ref: flavor }).lean();
    if (!product) {
      throw new Error(`Birthday cake flavor not found: "${flavor}"`);
    }

    // price in DB is the per-kg base price; frontend uses fixed tier pricing.
    // We replicate the same tier map to stay consistent with the displayed price.
    const weightTiers = { 0.5: 450, 1.0: 850, 1.5: 1250, 2.0: 1600 };
    const resolvedPrice = weightTiers[weight];

    if (resolvedPrice === undefined) {
      throw new Error(`Unsupported weight option (${weight}kg) for "${item.name}"`);
    }

    return { resolvedPrice, product };
  }

  // Standard item: id is a numeric id_ref
  const numericId = Number(item.id);
  if (!item.id || isNaN(numericId)) {
    throw new Error(`Missing or invalid product ID for item: "${item.name}"`);
  }

  const product = await Product.findOne({ type: 'standard', id_ref: numericId }).lean();
  if (!product) {
    throw new Error(`Product not found for ID ${numericId} ("${item.name}")`);
  }

  return { resolvedPrice: product.price, product };
}

async function createOrder(req, res) {
  try {
    const { customer_name, phone, address, city, pincode, items, total: clientTotal } = req.body;

    if (!customer_name || !phone || !address || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (!city || !pincode) {
      return res.status(400).json({ success: false, message: 'City and pincode are required' });
    }

    // ── PRICE VERIFICATION ──────────────────────────────────────────────────────
    const verifiedItems = [];
    let serverTotal = 0;

    for (const item of items) {
      const qty = Number(item.qty);
      if (!qty || qty < 1 || !Number.isInteger(qty)) {
        return res.status(400).json({ success: false, message: `Invalid quantity for item: "${item.name}"` });
      }

      let resolvedPrice, product;
      try {
        ({ resolvedPrice, product } = await resolveItemPrice(item));
      } catch (lookupErr) {
        return res.status(422).json({ success: false, message: lookupErr.message });
      }

      serverTotal += resolvedPrice * qty;

      verifiedItems.push({
        id: item.id,
        name: product.name,               // use canonical name from DB
        price: resolvedPrice,             // server-authoritative price
        qty,
        emoji: product.emoji || item.emoji || '🍫',
        category: product.category || item.category || 'general',
        customizations: item.customizations || null,
      });
    }

    // ── TOTAL CROSS-CHECK ───────────────────────────────────────────────────────
    if (clientTotal !== undefined) {
      const tolerance = 1; // ₹1 tolerance for floating-point rounding
      if (Math.abs(Number(clientTotal) - serverTotal) > tolerance) {
        return res.status(422).json({
          success: false,
          message: 'Order total mismatch. Please refresh and try again.',
          expected: serverTotal,
        });
      }
    }

    // ── PERSIST ─────────────────────────────────────────────────────────────────
    const order_id = generateOrderId();
    const order = await Order.create({
      order_id,
      customer_name,
      phone,
      address,
      city,
      pincode,
      items: verifiedItems,
      total: serverTotal,
    });

    res.json({ success: true, order_id: order.order_id, message: 'Order placed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
}

async function getAllOrders(req, res) {
  try {
    const { status } = req.query;
    const filter = {};

    if (status && status !== 'all') {
      filter.$or = [{ status }, { payment_status: status }];
    }

    const orders = await Order.find(filter).sort({ created_at: -1 }).lean();
    res.json({ success: true, orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

async function getOrder(req, res) {
  try {
    const order = await Order.findOne({ order_id: req.params.orderId }).lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

async function confirmPayment(req, res) {
  try {
    const { notes } = req.body;
    const order = await Order.findOneAndUpdate(
      { order_id: req.params.orderId },
      {
        payment_status: 'paid',
        status: 'confirmed',
        confirmed_at: new Date(),
        notes: notes || 'Payment confirmed via WhatsApp',
      },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, message: 'Payment confirmed' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

async function updateOrderStatus(req, res) {
  try {
    const { status } = req.body;
    const order = await Order.findOneAndUpdate(
      { order_id: req.params.orderId },
      { status },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

async function getStats(req, res) {
  try {
    const [totalOrders, pendingOrders, paidOrders, revenueResult] = await Promise.all([
      Order.countDocuments(),
      Order.countDocuments({ status: 'pending' }),
      Order.countDocuments({ payment_status: 'paid' }),
      Order.aggregate([
        { $match: { payment_status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]),
    ]);

    res.json({
      success: true,
      stats: {
        total_orders: totalOrders,
        pending_orders: pendingOrders,
        paid_orders: paidOrders,
        total_revenue: revenueResult[0]?.total || 0,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

module.exports = { createOrder, getAllOrders, getOrder, confirmPayment, updateOrderStatus, getStats };

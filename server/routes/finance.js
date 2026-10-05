const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { requireAdmin } = require('../middleware/requireAuth');
const { calculate } = require('../services/costingMath');

// Деньги: сколько на самом деле осталось после Kaspi и материалов.
//
// Зачем отдельный раздел. API заказов не отдаёт комиссию площадки ни одним полем -
// только сумму заказа и доставку за счёт продавца. Поэтому «прибыль», посчитанная по
// заказам, всегда завышена примерно на 12% оборота. Единственный источник факта -
// выгрузка Kaspi Pay из кабинета («Отчёт по продажам»), где по каждой операции стоит,
// сколько удержали. Её сюда и загружают, а расчёт сводит три вещи: деньги Kaspi,
// состав заказа и себестоимость изделия.
//
// Здесь только владелец: это выручка, удержания и маржа целиком.
router.use(requireAdmin);

// Ключ для сопоставления по названию: регистр, ё/е и знаки между словами мешать не должны.
const nameKey = (s) =>
  String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();

// Сопоставление названия со списком себестоимости. Точного совпадения мало: на карточке
// Kaspi к имени дописаны размеры и цвет («Распашной шкаф Лорд, 160x200х49 см, белый»),
// а в списке стоит короткое «Распашной шкаф Лорд». Поэтому пробуем, как в «Аналитике»:
// точно, затем самый длинный ключ, с которого название начинается, затем наоборот -
// название как начало ключа, затем вхождение. Если подходит несколько записей С РАЗНОЙ
// ценой, не берём ничего: угадать тут дороже, чем показать пробел.
function makeNameMatcher(rows) {
  const exact = new Map();
  const keys = [];
  for (const r of rows) {
    const k = nameKey(r.name);
    if (!k) continue;
    exact.set(k, Number(r.cost));
    if (k.length >= 4) keys.push({ k, v: Number(r.cost) });
  }
  const only = (list) => (list.length && new Set(list.map((x) => x.v)).size === 1 ? list[0].v : null);
  return (name) => {
    const n = nameKey(name);
    if (!n) return null;
    if (exact.has(n)) return exact.get(n);
    let v = only(keys.filter((x) => x.k.length >= 8 && n.startsWith(x.k)));
    if (v !== null) return v;
    v = only(keys.filter((x) => n.length >= 9 && x.k.startsWith(n)));
    if (v !== null) return v;
    return only(keys.filter((x) => x.k.length >= 12 && n.includes(x.k)));
  };
}

async function loadNameCosts() {
  const { rows } = await db.query('SELECT name, cost FROM cost_by_name');
  return makeNameMatcher(rows);
}

const MAX_ROWS = 20000;
const validDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

// Себестоимость изделий с кодом технолога. Повторяет расчёт «Аналитики»: формула
// применяется к спецификации, а код без спецификации считается неизвестным - иначе
// из одних тарифов вышло бы около трёх тысяч тенге, и прибыль почти равнялась бы выручке.
async function costPerProduct() {
  const { rows: products } = await db.query('SELECT * FROM cost_products');
  const { rows: lines } = await db.query(`
    SELECT pi.product_id, pi.quantity, pi.price, i.kind, i.counts_as
    FROM cost_product_items pi JOIN cost_items i ON i.id = pi.item_id`);
  const byProduct = new Map();
  for (const line of lines) {
    if (!byProduct.has(line.product_id)) byProduct.set(line.product_id, []);
    byProduct.get(line.product_id).push(line);
  }
  return new Map(products.map((p) => {
    const own = byProduct.get(p.id) || [];
    return [p.id, { code: p.code, cost: own.length > 0 ? calculate(p, own).cost : null }];
  }));
}

// POST /api/finance/kaspipay - загрузить разобранный отчёт Kaspi Pay.
// Файл разбирает браузер, сюда приходят готовые строки: так не нужна ещё одна
// зависимость на сервере, а формат описан в одном месте - во фронте.
router.post('/kaspipay', async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : null;
    const sourceFile = String(req.body.file || '').slice(0, 200) || null;
    if (!rows || rows.length === 0) return res.status(400).json({ error: 'Нет строк для загрузки' });
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ error: `Слишком много строк (${rows.length}), максимум ${MAX_ROWS}` });
    }

    const clean = [];
    let skipped = 0;
    for (const r of rows) {
      const code = String(r.orderCode || '').trim();
      const date = validDate(String(r.date || '').trim());
      const amount = Number(r.amount);
      if (!code || !date || !Number.isFinite(amount)) { skipped++; continue; }
      clean.push({
        code,
        merchant: String(r.merchant || '').slice(0, 120) || null,
        date,
        time: String(r.time || '').slice(0, 10) || null,
        amount,
        // Удержания в отчёте идут со знаком минус - храним как есть, чтобы суммы
        // складывались без догадок о знаке.
        fee: Number(r.fee) || 0,
        delivery: Number(r.delivery) || 0,
        other: Number(r.other) || 0,
        term: String(r.term || '').slice(0, 20) || null,
        item: String(r.item || '').slice(0, 500) || null,
      });
    }
    if (clean.length === 0) return res.status(400).json({ error: 'Ни одной пригодной строки' });

    // Повторная загрузка того же файла не должна удваивать обороты, поэтому ключ -
    // заказ + дата + время + сумма: внутри одной операции они не повторяются.
    let inserted = 0;
    const CHUNK = 400;
    for (let i = 0; i < clean.length; i += CHUNK) {
      const part = clean.slice(i, i + CHUNK);
      const values = [];
      const placeholders = part.map((row, k) => {
        values.push(row.code, row.merchant, row.date, row.time, row.amount,
          row.fee, row.delivery, row.other, row.term, row.item, sourceFile);
        const b = k * 11;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`;
      }).join(',');
      const result = await db.query(
        `INSERT INTO kaspi_pay_operations
           (order_code, merchant, op_date, op_time, amount, fee_total, delivery, other_fees, payment_term, item_name, source_file)
         VALUES ${placeholders}
         ON CONFLICT (order_code, op_date, op_time, amount) DO NOTHING`,
        values
      );
      inserted += result.rowCount;
    }

    const { rows: [range] } = await db.query(
      `SELECT min(op_date)::text AS from, max(op_date)::text AS to, count(*)::int AS total
       FROM kaspi_pay_operations`
    );
    res.json({
      received: rows.length,
      accepted: clean.length,
      inserted,
      duplicates: clean.length - inserted,
      skipped,
      range,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/finance/periods - какие месяцы уже загружены
router.get('/periods', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT to_char(op_date, 'YYYY-MM') AS month,
              count(*)::int AS operations,
              min(op_date)::text AS first_day,
              max(op_date)::text AS last_day,
              COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)::numeric AS sales,
              COALESCE(SUM(fee_total + other_fees), 0)::numeric AS fees,
              COALESCE(SUM(delivery), 0)::numeric AS delivery
       FROM kaspi_pay_operations
       GROUP BY 1 ORDER BY 1 DESC`
    );
    res.json({
      data: rows.map((r) => ({
        month: r.month,
        operations: r.operations,
        firstDay: r.first_day,
        lastDay: r.last_day,
        sales: Math.round(Number(r.sales)),
        fees: Math.round(Number(r.fees)),
        delivery: Math.round(Number(r.delivery)),
      })),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/finance/report?from=&to= - что осталось после Kaspi и материалов
router.get('/report', async (req, res, next) => {
  try {
    const from = validDate(req.query.from), to = validDate(req.query.to);
    if (!from || !to) return res.status(400).json({ error: 'Нужны даты from и to в виде ГГГГ-ММ-ДД' });

    const [spec, byName] = await Promise.all([costPerProduct(), loadNameCosts()]);

    const { rows } = await db.query(
      `WITH ops AS (
         SELECT order_code,
                SUM(amount) AS amount,
                SUM(fee_total + other_fees) AS fees,
                SUM(delivery) AS delivery,
                MIN(merchant) AS merchant
         FROM kaspi_pay_operations
         WHERE op_date BETWEEN $1::date AND $2::date
         GROUP BY order_code
       )
       SELECT ops.order_code, ops.merchant, ops.amount, ops.fees, ops.delivery,
              oi.name, oi.quantity, p.cost_product_id
       FROM ops
       LEFT JOIN orders o ON o.order_code = ops.order_code
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN products p ON p.store_id = o.store_id AND p.sku = oi.sku
       ORDER BY ops.order_code`,
      [from, to]
    );

    const orders = new Map();
    for (const r of rows) {
      if (!orders.has(r.order_code)) {
        orders.set(r.order_code, {
          code: r.order_code, merchant: r.merchant,
          amount: Number(r.amount), fees: Number(r.fees), delivery: Number(r.delivery),
          lines: [], hasLines: false,
        });
      }
      if (!r.name) continue;
      const o = orders.get(r.order_code);
      o.hasLines = true;
      // Сначала код технолога, и только если его нет - список по названию: расчёт по
      // спецификации точнее ручной цифры и не должен ею перебиваться.
      const byCode = r.cost_product_id ? spec.get(r.cost_product_id) : null;
      const fromSpec = byCode && byCode.cost !== null;
      const unit = fromSpec ? byCode.cost : byName(r.name);
      o.lines.push({
        name: r.name, quantity: r.quantity || 1, unit,
        source: fromSpec ? 'код технолога' : (unit !== null ? 'список по названию' : null),
      });
    }

    const money = { sales: 0, refunds: 0, fees: 0, delivery: 0, cost: 0 };
    const skipped = { orders: 0, amount: 0, notInBase: 0 };
    const bySource = {};
    let counted = 0;
    for (const o of orders.values()) {
      if (o.amount < 0) { money.refunds += o.amount; continue; }
      const costed = o.hasLines && o.lines.every((l) => l.unit !== null);
      // Заказ без полной себестоимости выбрасываем целиком: иначе его выручка попадёт
      // в доход, а затраты на него - нет, и прибыль окажется завышенной.
      if (!costed) {
        skipped.orders++;
        skipped.amount += o.amount;
        if (!o.hasLines) skipped.notInBase++;
        continue;
      }
      money.sales += o.amount;
      money.fees += o.fees;
      money.delivery += o.delivery;
      for (const l of o.lines) {
        money.cost += l.unit * l.quantity;
        bySource[l.source] = (bySource[l.source] || 0) + 1;
      }
      counted++;
    }

    const received = money.sales + money.fees + money.delivery;
    const profit = received - money.cost;
    const share = (v) => (money.sales ? Number((v / money.sales * 100).toFixed(2)) : null);

    res.json({
      range: { from, to },
      orders: {
        counted,
        skipped: skipped.orders,
        skippedAmount: Math.round(skipped.amount),
        notInBase: skipped.notInBase,
      },
      costSource: bySource,
      money: {
        sales: Math.round(money.sales),
        refunds: Math.round(money.refunds),
        fees: Math.round(money.fees),
        delivery: Math.round(money.delivery),
        received: Math.round(received),
        cost: Math.round(money.cost),
        profit: Math.round(profit),
      },
      shares: {
        fees: share(-money.fees),
        delivery: share(-money.delivery),
        cost: share(money.cost),
        profit: share(profit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/finance/uncosted?from=&to= - из-за каких позиций заказы выпали из расчёта
router.get('/uncosted', async (req, res, next) => {
  try {
    const from = validDate(req.query.from), to = validDate(req.query.to);
    if (!from || !to) return res.status(400).json({ error: 'Нужны даты from и to' });

    const [spec, byName] = await Promise.all([costPerProduct(), loadNameCosts()]);
    const { rows } = await db.query(
      `WITH ops AS (
         SELECT order_code, SUM(amount) AS amount
         FROM kaspi_pay_operations
         WHERE op_date BETWEEN $1::date AND $2::date
         GROUP BY order_code HAVING SUM(amount) > 0
       )
       SELECT oi.name, p.cost_product_id, ops.amount
       FROM ops
       JOIN orders o ON o.order_code = ops.order_code
       JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN products p ON p.store_id = o.store_id AND p.sku = oi.sku`,
      [from, to]
    );

    const agg = new Map();
    for (const r of rows) {
      const byCode = r.cost_product_id ? spec.get(r.cost_product_id) : null;
      if ((byCode && byCode.cost !== null) || byName(r.name) !== null) continue;
      if (!agg.has(r.name)) agg.set(r.name, { name: r.name, orders: 0, amount: 0 });
      const a = agg.get(r.name);
      a.orders++;
      a.amount += Number(r.amount);
    }
    const data = [...agg.values()]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 100)
      .map((r) => ({ name: r.name, orders: r.orders, amount: Math.round(r.amount) }));
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

// GET /api/finance/costs - список себестоимости по названию
router.get('/costs', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, cost, note, updated_at, updated_by FROM cost_by_name ORDER BY name`
    );
    res.json({ data: rows.map((r) => ({ ...r, cost: Number(r.cost) })) });
  } catch (error) {
    next(error);
  }
});

// POST /api/finance/costs - добавить или поправить себестоимость по названию.
// Принимает и одну позицию, и список целиком (перенос прайса).
router.post('/costs', async (req, res, next) => {
  try {
    const list = Array.isArray(req.body.items)
      ? req.body.items
      : (req.body.name ? [{ name: req.body.name, cost: req.body.cost, note: req.body.note }] : null);
    if (!list || list.length === 0) return res.status(400).json({ error: 'Нечего сохранять' });
    if (list.length > 5000) return res.status(400).json({ error: 'Слишком длинный список' });

    let saved = 0;
    for (const raw of list) {
      const name = String(raw.name || '').trim();
      const cost = Number(raw.cost);
      if (!name || !Number.isFinite(cost) || cost < 0) continue;
      await db.query(
        `INSERT INTO cost_by_name (name, name_key, cost, note, updated_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name_key) DO UPDATE SET
           name = EXCLUDED.name,
           cost = EXCLUDED.cost,
           note = COALESCE(EXCLUDED.note, cost_by_name.note),
           updated_at = now(),
           updated_by = EXCLUDED.updated_by`,
        [name, nameKey(name), cost, raw.note ? String(raw.note).slice(0, 300) : null, req.user?.email || null]
      );
      saved++;
    }
    res.json({ saved, received: list.length });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/finance/costs/:id
router.delete('/costs/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM cost_by_name WHERE id = $1', [Number(req.params.id)]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
    res.json({ deleted: Number(req.params.id) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

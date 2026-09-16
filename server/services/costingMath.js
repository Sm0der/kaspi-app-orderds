// Расчёт себестоимости изделия. Вынесен из routes/costing.js, потому что теми же
// формулами считает маржу раздел аналитики: цифра в «Себестоимости» и цифра в отчёте
// владельца должны совпадать до тенге, а не расходиться из-за двух копий формулы.
//
// Формулы повторяют ПРАЙС технолога, проверено на живых изделиях:
//   распил   = квадратура ЛДСП × тариф распила
//   кромка   = метры ПВХ × тариф кромки
//   упаковка, отправка, накладные - за каждую коробку
//   база     = себестоимость / 0.74, маржа = 25% базы, опт = себестоимость + маржа
//   Kaspi    = опт × 1.25
function calculate(product, lines) {
  const materials = lines.reduce((sum, l) => sum + Number(l.quantity) * Number(l.price), 0);
  const sawArea = lines.filter(l => l.counts_as === 'saw_area').reduce((s, l) => s + Number(l.quantity), 0);
  const edgeLength = lines.filter(l => l.counts_as === 'edge_length').reduce((s, l) => s + Number(l.quantity), 0);
  const boxes = lines.filter(l => l.kind === 'packaging').reduce((s, l) => s + Number(l.quantity), 0) || 1;

  const saw = sawArea * Number(product.rate_saw);
  const edge = edgeLength * Number(product.rate_edge);
  const drilling = Number(product.drilling_cost);
  const packing = boxes * Number(product.rate_pack);
  const shipping = boxes * Number(product.rate_ship);
  const overhead = boxes * Number(product.rate_overhead);

  const works = saw + edge + drilling + packing + shipping + overhead;
  const cost = materials + works;
  const base = Number(product.margin_divisor) > 0 ? cost / Number(product.margin_divisor) : cost;
  const margin = base * Number(product.margin_rate);
  const wholesale = cost + margin;
  const kaspiPrice = wholesale * (1 + Number(product.kaspi_markup));

  const round = (v) => Math.round(v);
  return {
    materials: round(materials), sawArea, edgeLength, boxes,
    saw: round(saw), edge: round(edge), drilling: round(drilling),
    packing: round(packing), shipping: round(shipping), overhead: round(overhead),
    works: round(works), cost: round(cost),
    margin: round(margin), wholesale: round(wholesale), kaspiPrice: round(kaspiPrice)
  };
}

module.exports = { calculate };

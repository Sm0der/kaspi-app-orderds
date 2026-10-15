'use client';

import { useState } from 'react';

// Стоит ли бороться за место, когда конкурент встал дешевле.
//
// Панель «Что изменилось на карточках» раньше говорила «нас обошли» и замолкала.
// Ответ на вопрос «и что делать» требует трёх цифр, которые у нас есть: себестоимость
// технолога, ФАКТИЧЕСКАЯ доставка из наших же заказов по этой карточке и комиссия
// Kaspi 11,75%. Из них считается, сколько останется с штуки при цене конкурента —
// и видно, бороться вообще стоит или мы уже у дна.
//
// ДВА СПОСОБА ОБОЙТИ КОНКУРЕНТА, и они неравнозначны:
//
//   1. СКИДКА — опустить цену ниже. Берёт меньше комиссии (она процент от цены),
//      поэтому чистыми оставляет БОЛЬШЕ. Но демпинг-бот конкурента видит цену и
//      опускает свою следом: война, в которой побеждает тот, у кого ниже
//      себестоимость.
//
//   2. БОНУС — цену не трогать, дать покупателю N% бонусами. Для покупателя это
//      та же скидка: при 90 000 и 5% он платит как за 85 500. А вот ЧУЖОЙ БОТ
//      бонуса не видит — он сравнивает цены, а цена у нас прежняя, и реагировать
//      ему не на что. Платим за это лишней комиссией: она считается с полной цены.
//
// Разница между способами ровно одна и считается точно: комиссия с той части цены,
// которую скидка убрала бы, а бонус оставляет. При 11,75% и разрыве в 10 000 ₸ это
// 1 175 ₸ с штуки — цена того, чтобы не будить чужой бот.

const COMMISSION = 11.75;
const money = (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Math.round(v).toLocaleString('ru-RU'));
// Бонус Kaspi задаётся целыми процентами
const BONUS_STEPS = [1, 2, 3, 5, 7, 10];

export default function PriceFight({ row }) {
  const [open, setOpen] = useState(false);

  const cost = row.cost;
  const ship = row.delivery;
  const our = row.ourPrice;
  const rival = row.bestPrice;

  // Считать нечего, если неизвестна себестоимость или мы и так дешевле всех
  if (cost === null || our === null || rival === null || our <= rival) return null;

  const net = (price, bonusPct = 0) => price * (1 - COMMISSION / 100 - bonusPct / 100) - (ship || 0) - cost;

  const nowNet = net(our);
  // Чтобы обойти, достаточно одного тенге
  const target = rival - 1;
  const cutNet = net(target);

  // Цена, ниже которой мы в убытке. Если конкурент уже под ней — бороться не с чем,
  // он продаёт дешевле, чем нам обходится.
  const floor = (cost + (ship || 0)) / (1 - COMMISSION / 100);
  const hopeless = rival <= floor;

  // Какой бонус делает нас дешевле для покупателя: our × (1 − b) ≤ target.
  // Kaspi принимает целые проценты, поэтому берём ближайший сверху.
  const needPct = Math.max(0, (1 - target / our) * 100);
  const bonusPct = BONUS_STEPS.find((b) => b >= needPct) ?? null;
  const bonusNet = bonusPct === null ? null : net(our, bonusPct);
  const bonusEffective = bonusPct === null ? null : our * (1 - bonusPct / 100);

  const lossFromCut = nowNet - cutNet;
  const lossFromBonus = bonusNet === null ? null : nowNet - bonusNet;
  // Бонус всегда дороже скидки: комиссия берётся с полной цены, которую он не трогает
  const bonusCostsMore = bonusNet === null ? null : cutNet - bonusNet;
  // Разрыв меньше процента — целый процент бонуса отдаёт куда больше, чем нужно
  const overshoot = needPct < 1;

  const verdict = hopeless
    ? { tone: 'bad', text: `Бороться не с чем: в ноль мы выходим на ${money(floor)} ₸, а конкурент уже ${money(rival)} ₸. Он продаёт дешевле, чем нам обходится.` }
    : bonusPct === null
      ? { tone: 'mid', text: `Разрыв ${money(our - rival)} ₸ — это больше ${BONUS_STEPS[BONUS_STEPS.length - 1]}% бонуса, бонусом его не закрыть. Остаётся скидка: ${money(cutNet)} ₸ с штуки.` }
      : overshoot
        ? { tone: 'mid', text: `Разрыв всего ${money(our - rival)} ₸ — хватило бы бонуса ${needPct.toFixed(2)}%, а меньше 1% Kaspi не принимает. Проще скинуть цену: ${money(cutNet)} ₸ против ${money(bonusNet)} ₸ бонусом.` }
        : bonusNet > 0
          ? { tone: 'ok', text: `Бонус ${bonusPct}% — для покупателя это ${money(bonusEffective)} ₸, дешевле конкурента, а бот его не видит и цену не уронит. Стоит это ${money(bonusCostsMore)} ₸ с штуки против скидки.` }
          : { tone: 'bad', text: `Бонус ${bonusPct}% уводит в минус (${money(bonusNet)} ₸). Скидкой остаётся ${money(cutNet)} ₸, но бот ответит.` };

  return (
    <>
      <button className="btn btn-quiet btn-sm" onClick={() => setOpen(!open)}>
        {open ? 'Свернуть' : 'Считать'}
      </button>
      {open && (
        <div className="fight">
          <div className="fight-row">
            <span>Сейчас {money(our)} ₸</span>
            <b data-loss={nowNet <= 0 || undefined}>{money(nowNet)} ₸ с штуки</b>
          </div>
          <div className="fight-row">
            <span>Скидка до {money(target)} ₸</span>
            <b data-loss={cutNet <= 0 || undefined}>{money(cutNet)} ₸</b>
            <i>−{money(lossFromCut)} ₸ · бот конкурента увидит и опустит свою</i>
          </div>
          {bonusPct === null ? (
            <div className="fight-row">
              <span>Бонусом не закрыть</span>
              <b>—</b>
              <i>нужно {needPct.toFixed(1)}%, а это больше, чем даём</i>
            </div>
          ) : (
            <div className="fight-row">
              <span>Бонус {bonusPct}% при цене {money(our)} ₸</span>
              <b data-loss={bonusNet <= 0 || undefined}>{money(bonusNet)} ₸</b>
              <i>−{money(lossFromBonus)} ₸ · покупателю как {money(bonusEffective)} ₸, бот бонус не видит
                {overshoot && <> · хватило бы {needPct.toFixed(2)}%</>}</i>
            </div>
          )}
          <div className="fight-calc">
            себестоимость {money(cost)} ₸ · доставка {ship === null ? 'неизвестна' : money(ship) + ' ₸'}
            {row.deliveryOrders > 0 && ship !== null && <> (по {row.deliveryOrders} однотоварным заказам)</>}
            {' '}· комиссия {COMMISSION}% · в ноль выходим на {money(floor)} ₸
          </div>
          <div className={`fight-verdict ${verdict.tone}`}>{verdict.text}</div>
        </div>
      )}
      <style jsx global>{`
        .fight { margin-top: 8px; padding: 10px 12px; background: var(--ink-800); border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: 13px; text-align: left; }
        .fight-row { display: grid; grid-template-columns: minmax(150px, auto) 110px 1fr; gap: 10px; align-items: baseline; padding: 4px 0; }
        .fight-row b { font-variant-numeric: tabular-nums; text-align: right; }
        .fight-row i { font-style: normal; color: var(--text-dim); font-size: 12px; }
        .fight-calc { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--line); color: var(--text-faint); font-size: 12px; }
        .fight-verdict { margin-top: 8px; padding: 7px 10px; border-radius: var(--radius-sm); font-size: 13px; }
        .fight-verdict.ok { background: var(--alert-ok-bg); color: var(--alert-ok-text); }
        .fight-verdict.mid { background: var(--brass-wash); }
        .fight-verdict.bad { background: var(--alert-error-bg); color: var(--alert-error-text); }
        @media (max-width: 820px) { .fight-row { grid-template-columns: 1fr auto; } .fight-row i { grid-column: 1 / -1; } }
      `}</style>
    </>
  );
}

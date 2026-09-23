import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { guard } from '@/lib/guard';
import { syncProductCostLinks } from '@/lib/costLink';
import { ApiResponse } from '@/types';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    const body = await request.json();
    const data: Prisma.WarehouseItemUpdateInput = {};

    if (body.code !== undefined) {
      const code = String(body.code).trim();
      if (code.length < 2) return bad('Код изделия слишком короткий');
      data.code = code;
    }
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (name.length < 2) return bad('Укажите название изделия');
      data.name = name;
    }
    if (body.boxesPerUnit !== undefined) {
      const boxesPerUnit = Number(body.boxesPerUnit);
      if (!(boxesPerUnit >= 1)) return bad('Коробок в 1 штуке должно быть не меньше 1');
      data.boxesPerUnit = boxesPerUnit;
    }
    if (body.imageUrl !== undefined) {
      data.imageUrl = String(body.imageUrl).trim() || null;
    }
    if (body.warehouseId !== undefined) {
      data.warehouse = body.warehouseId ? { connect: { id: String(body.warehouseId) } } : { disconnect: true };
    }
    // Ручная поправка остатка - для случая, когда физический пересчёт разошёлся с
    // системой (потеря, находка, ошибка приёмки). Обычный путь для остатка - печать
    // этикеток и сканирование, а не эта форма.
    if (body.quantityOnHand !== undefined) {
      const quantityOnHand = Number(body.quantityOnHand);
      if (!(quantityOnHand >= 0)) return bad('Остаток не может быть отрицательным');
      data.quantityOnHand = quantityOnHand;
    }
    // Код технолога - ручная привязка владельцем, без подсказок (см. план сопоставления).
    // null снимает код обратно.
    if (body.costProductId !== undefined) {
      data.costProductId = body.costProductId === null ? null : Number(body.costProductId);
    }

    if (Object.keys(data).length === 0) return bad('Нечего менять');

    data.updatedAt = new Date();
    const item = await prisma.warehouseItem.update({ where: { id }, data });
    // Код технолога проставлен на изделии - разложим его по артикулам, иначе маржа
    // в «Аналитике» считается по products.cost_product_id и осталась бы пустой.
    // Изделие уже сохранено - если это упадёт, не отвечаем "не удалось сохранить":
    // владелец решил бы, что вся правка не применилась, хотя она применилась.
    if (body.costProductId !== undefined) {
      try {
        await syncProductCostLinks(id);
      } catch (error) {
        console.error('Item saved but cost-link sync failed:', error);
      }
    }
    return NextResponse.json({ success: true, data: item } as ApiResponse<unknown>);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') return bad('Изделие с таким кодом уже есть');
      // P2025 здесь означает ЛИБО что нет изделия, ЛИБО что connect() не нашёл склад
      // с таким warehouseId (например, устаревший список в форме) - само изделие
      // при этом на месте, и "Изделие не найдено" сбило бы с толку
      if (error.code === 'P2025') return bad('Изделие или выбранный склад не найдены');
      if (error.code === 'P2003') return bad('Такого кода технолога не существует');
    }
    console.error('Update warehouse item error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось сохранить изменения' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await guard(request, 'admin');
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    await prisma.warehouseItem.delete({ where: { id } });
    return NextResponse.json({ success: true, data: { id } } as ApiResponse<unknown>);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') return bad('Изделие не найдено');
      // За изделием уже тянутся штрихкоды, партии этикеток или движения склада -
      // стирать эту историю нельзя, только отвязать все SKU и оставить как есть.
      if (error.code === 'P2003') {
        return bad('У изделия уже есть напечатанные этикетки или движения склада - удалить нельзя');
      }
    }
    console.error('Delete warehouse item error:', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось удалить изделие' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

function bad(error: string) {
  return NextResponse.json({ success: false, error } as ApiResponse<null>, { status: 400 });
}

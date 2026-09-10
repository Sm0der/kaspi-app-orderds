import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

// Производство устроено как очередь цехов. У изделия есть текущий цех; рабочий этого цеха
// отчитывается «сделал N штук», и когда набирается всё количество, задача сама уезжает
// в следующий цех по order_sequence. После последнего цеха задача закрыта.
//
// Остатки склада отсюда НЕ трогаем: на склад изделие попадает приёмкой по штрихкоду
// (см. api/warehouse/receive), и увеличивать quantity_on_hand ещё и здесь означало бы
// считать одну и ту же штуку дважды.

const taskInclude = {
  currentWorkshop: true,
  warehouseItem: { select: { imageUrl: true, code: true } },
  workshopOperations: {
    include: { worker: { select: { fullName: true } }, workshop: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  },
} satisfies Prisma.ProductionItemInclude;

type TaskRow = Prisma.ProductionItemGetPayload<{ include: typeof taskInclude }>;

export interface Task {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  status: string;
  notes: string | null;
  imageUrl: string | null;
  code: string | null;
  workshopId: string;
  workshopName: string;
  /** Принято в текущем цехе - именно от него считается «осталось» */
  doneHere: number;
  defectsHere: number;
  remaining: number;
  createdAt: Date;
  history: {
    id: string;
    workshop: string;
    worker: string;
    quantity: number;
    status: string;
    notes: string | null;
    at: Date;
  }[];
}

function shape(row: TaskRow): Task {
  const here = row.workshopOperations.filter((op) => op.workshopId === row.currentWorkshopId);
  const doneHere = here
    .filter((op) => op.status === 'COMPLETED')
    .reduce((sum, op) => sum + op.quantityCompleted, 0);
  const defectsHere = here
    .filter((op) => op.status === 'DEFECTIVE')
    .reduce((sum, op) => sum + op.quantityCompleted, 0);

  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    unit: row.unit,
    status: row.status,
    notes: row.notes,
    imageUrl: row.warehouseItem?.imageUrl ?? null,
    code: row.warehouseItem?.code ?? null,
    workshopId: row.currentWorkshopId,
    workshopName: row.currentWorkshop.name,
    doneHere,
    defectsHere,
    remaining: Math.max(0, row.quantity - doneHere),
    createdAt: row.createdAt,
    history: row.workshopOperations.map((op) => ({
      id: op.id,
      workshop: op.workshop.name,
      worker: op.worker.fullName,
      quantity: op.quantityCompleted,
      status: op.status,
      notes: op.notes,
      at: op.completedAt ?? op.createdAt,
    })),
  };
}

/** Задачи, стоящие сейчас в этом цехе. Закрытые не показываем - цех их уже отдал дальше. */
export async function tasksForWorkshop(workshopId: string): Promise<Task[]> {
  const rows = await prisma.productionItem.findMany({
    where: { currentWorkshopId: workshopId, status: { not: 'COMPLETED' } },
    include: taskInclude,
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(shape);
}

/** Всё незакрытое производство - для мастера и владельца */
export async function boardTasks(): Promise<Task[]> {
  const rows = await prisma.productionItem.findMany({
    where: { status: { not: 'COMPLETED' } },
    include: taskInclude,
    orderBy: [{ currentWorkshop: { orderSequence: 'asc' } }, { createdAt: 'asc' }],
  });
  return rows.map(shape);
}

export async function taskById(id: string): Promise<Task | null> {
  const row = await prisma.productionItem.findUnique({ where: { id }, include: taskInclude });
  return row ? shape(row) : null;
}

/**
 * Записать выработку. Пересчёт «набралось ли всё количество» идёт внутри транзакции и по
 * свежим строкам: два рабочих одного цеха могут отчитаться одновременно, и без этого
 * задача уехала бы дальше с недоделанным остатком либо перескочила бы два цеха сразу.
 */
export async function recordOperation(params: {
  taskId: string;
  workerId: string;
  quantity: number;
  status: 'COMPLETED' | 'DEFECTIVE';
  notes?: string | null;
}): Promise<{ ok: true; movedTo: string | null; finished: boolean } | { ok: false; error: string }> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.productionItem.findUnique({
      where: { id: params.taskId },
      include: { currentWorkshop: true },
    });
    if (!item) return { ok: false as const, error: 'Задача не найдена' };
    if (item.status === 'COMPLETED') return { ok: false as const, error: 'Задача уже закрыта' };
    if (item.status === 'ON_HOLD') return { ok: false as const, error: 'Задача отложена - её должен возобновить мастер' };

    const done = await tx.workshopOperation.aggregate({
      where: { productionItemId: item.id, workshopId: item.currentWorkshopId, status: 'COMPLETED' },
      _sum: { quantityCompleted: true },
    });
    const already = done._sum.quantityCompleted ?? 0;
    const remaining = item.quantity - already;

    if (remaining <= 0) return { ok: false as const, error: 'В этом цехе уже сделано всё количество' };
    if (params.quantity > remaining) {
      return { ok: false as const, error: `Осталось ${remaining} ${item.unit}, больше принять нельзя` };
    }

    await tx.workshopOperation.create({
      data: {
        productionItemId: item.id,
        workshopId: item.currentWorkshopId,
        workerId: params.workerId,
        quantityCompleted: params.quantity,
        status: params.status,
        notes: params.notes || null,
        completedAt: new Date(),
      },
    });

    // Брак не двигает задачу: испорченные детали надо переделать, остаток не уменьшается
    if (params.status === 'DEFECTIVE') {
      await tx.productionItem.update({
        where: { id: item.id },
        data: { status: 'IN_PROGRESS', updatedAt: new Date() },
      });
      return { ok: true as const, movedTo: null, finished: false };
    }

    if (already + params.quantity < item.quantity) {
      await tx.productionItem.update({
        where: { id: item.id },
        data: { status: 'IN_PROGRESS', updatedAt: new Date() },
      });
      return { ok: true as const, movedTo: null, finished: false };
    }

    const next = await tx.workshop.findFirst({
      where: { orderSequence: { gt: item.currentWorkshop.orderSequence } },
      orderBy: { orderSequence: 'asc' },
    });

    await tx.productionItem.update({
      where: { id: item.id },
      data: next
        ? { currentWorkshopId: next.id, status: 'PENDING', updatedAt: new Date() }
        : { status: 'COMPLETED', updatedAt: new Date() },
    });

    return { ok: true as const, movedTo: next?.name ?? null, finished: !next };
  });
}

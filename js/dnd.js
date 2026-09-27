// Drag-to-reorder for a list whose items carry data-id and contain a
// .drag-handle. Uses pointer events so it works with mouse and touch;
// arrow keys on a focused handle move the item one step.

let dragging = false;
export const isDragging = () => dragging;

const idsOf = (list) => [...list.children].map((el) => el.dataset.id).join(',');

export function enableDragSort(list, { onMove, onDragEnd }) {
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || e.button !== 0) return;
    const item = handle.closest('[data-id]');
    e.preventDefault();

    dragging = true;
    const startOrder = idsOf(list);
    item.classList.add('dragging');

    const move = (ev) => {
      const others = [...list.children].filter((el) => el !== item && el.dataset.id);
      const before = others.find((el) => {
        const r = el.getBoundingClientRect();
        return ev.clientY < r.top + r.height / 2;
      }) ?? null;
      const alreadyThere = before ? item.nextElementSibling === before : list.lastElementChild === item;
      if (!alreadyThere) list.insertBefore(item, before);

      if (ev.clientY < 60) window.scrollBy(0, -12);
      else if (ev.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
    };

    const finish = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      item.classList.remove('dragging');
      dragging = false;
      const changed = idsOf(list) !== startOrder;
      onDragEnd?.();
      if (changed) onMove(item.dataset.id);
    };

    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  });

  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const item = handle.closest('[data-id]');
    const sibling = e.key === 'ArrowUp' ? item.previousElementSibling : item.nextElementSibling;
    if (!sibling?.dataset.id) return;
    e.preventDefault();
    if (e.key === 'ArrowUp') list.insertBefore(item, sibling);
    else list.insertBefore(sibling, item);
    onMove(item.dataset.id, { keyboard: true });
  });
}

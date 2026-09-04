function attachDivider(divider, { container, axis, min = 140, onResize, onResizeEnd }) {
  let dragging = false;
  let pointerId = null;

  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    pointerId = e.pointerId;
    try { divider.setPointerCapture(pointerId); } catch { /* not all targets support it */ }
    divider.classList.add('resizing');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const size = axis === 'x' ? rect.width : rect.height;
    if (size <= 0) return;
    const pos = axis === 'x' ? e.clientX - rect.left : e.clientY - rect.top;
    const minFrac = Math.min(0.45, min / size);
    const frac = Math.max(minFrac, Math.min(1 - minFrac, pos / size));
    onResize(frac);
  };

  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (pointerId != null) {
      try { divider.releasePointerCapture(pointerId); } catch { /* already released */ }
      pointerId = null;
    }
    divider.classList.remove('resizing');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    onResizeEnd?.();
  };

  divider.addEventListener('pointerdown', onDown);
  divider.addEventListener('pointermove', onMove);
  divider.addEventListener('pointerup', end);
  divider.addEventListener('pointercancel', end);

  return () => {
    divider.removeEventListener('pointerdown', onDown);
    divider.removeEventListener('pointermove', onMove);
    divider.removeEventListener('pointerup', end);
    divider.removeEventListener('pointercancel', end);
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { attachDivider };
}

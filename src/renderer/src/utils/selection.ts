export function toggleSelectId(currentIds: string[], id: string): string[] {
  if (currentIds.includes(id)) {
    return currentIds.filter((item) => item !== id);
  }
  return [...currentIds, id];
}

export function computeVisibleSelection(selectedIds: string[], visibleIds: string[]) {
  if (visibleIds.length === 0) {
    return {
      isAllSelected: false,
      isIndeterminate: false,
      selectedCount: 0,
    };
  }

  const selectedSet = new Set(selectedIds);
  let visibleSelectedCount = 0;
  for (const id of visibleIds) {
    if (selectedSet.has(id)) {
      visibleSelectedCount++;
    }
  }

  const isAllSelected = visibleSelectedCount === visibleIds.length;
  const isIndeterminate = visibleSelectedCount > 0 && visibleSelectedCount < visibleIds.length;

  return {
    isAllSelected,
    isIndeterminate,
    selectedCount: visibleSelectedCount,
  };
}

export function toggleSelectAllVisible(selectedIds: string[], visibleIds: string[]): string[] {
  if (visibleIds.length === 0) return selectedIds;

  const { isAllSelected } = computeVisibleSelection(selectedIds, visibleIds);
  const visibleSet = new Set(visibleIds);

  if (isAllSelected) {
    // Deselect all visible items while preserving hidden selections
    return selectedIds.filter((id) => !visibleSet.has(id));
  } else {
    // Select all visible items while preserving hidden selections
    const combined = new Set([...selectedIds, ...visibleIds]);
    return Array.from(combined);
  }
}

function normalizeDateFields(row) {
  if (!row) return row;
  try {
    if (row.created_at) {
      if (row.created_at instanceof Date) row.created_at = row.created_at.toISOString();
      else if (typeof row.created_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(row.created_at)) row.created_at = row.created_at + 'Z';
    }
    if (row.updated_at) {
      if (row.updated_at instanceof Date) row.updated_at = row.updated_at.toISOString();
      else if (typeof row.updated_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(row.updated_at)) row.updated_at = row.updated_at + 'Z';
    }
    if (row.scheduled_date) {
      if (row.scheduled_date instanceof Date) row.scheduled_date = row.scheduled_date.toISOString().split('T')[0];
      else if (typeof row.scheduled_date === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(row.scheduled_date)) row.scheduled_date = row.scheduled_date.split('T')[0];
    }
  } catch (e) {}
  return row;
}

module.exports = { normalizeDateFields };

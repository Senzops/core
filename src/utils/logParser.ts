export const parseLogQuery = (searchString: string, ownerId: string, startDate: Date) => {
  const query: any = { ownerId, timestamp: { $gte: startDate } };
  if (!searchString || !searchString.trim()) return query;

  // Regex to match key:value, key:"value", or key:'value'
  const filterRegex = /(\w+):(?:(["'])(.*?)\2|([^ ]+))/g;
  let match;
  let remainingSearch = searchString;

  while ((match = filterRegex.exec(searchString)) !== null) {
    const key = match[1];
    const value = match[3] || match[4];

    // Remove the extracted filter from the remaining free-text search
    remainingSearch = remainingSearch.replace(match[0], '');

    if (key === 'level') {
      query.level = { $regex: new RegExp(`^${value}$`, 'i') };
    } else if (key === 'message') {
      query.message = { $regex: new RegExp(value, 'i') };
    } else if (key === 'traceId') {
      query.traceId = value;
    } else {
      // Dynamically query the wildcard attributes object
      // Cast numeric strings to numbers to match accurately
      const numValue = Number(value);
      query[`attributes.${key}`] = !isNaN(numValue) ? numValue : { $regex: new RegExp(`^${value}$`, 'i') };
    }
  }

  remainingSearch = remainingSearch.trim();

  if (remainingSearch) {
    // If there is text left over, use MongoDB Regex for partial matching
    query.$or = [
      { message: { $regex: new RegExp(remainingSearch, 'i') } }
    ];
  }

  return query;
};
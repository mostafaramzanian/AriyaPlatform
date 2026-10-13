-- Phase 49J: the stored generated-column expression for `searchVector`.
-- Kept in a file rather than inlined into a shell command: the psql `-c` form has to
-- survive PowerShell quoting, and a mangled quote here would produce a misleading
-- "column not generated" result.
SELECT a.attname,
       pg_get_expr(d.adbin, d.adrelid) AS generation_expression
FROM pg_attrdef d
JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
WHERE d.adrelid = '"SearchDocument"'::regclass
  AND a.attgenerated <> '';

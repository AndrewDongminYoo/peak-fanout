\set ON_ERROR_STOP on

SELECT format(
  'CREATE ROLE %I WITH LOGIN REPLICATION PASSWORD %L',
  :'replication_user',
  :'replication_password'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'replication_user')
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN REPLICATION PASSWORD %L',
  :'replication_user',
  :'replication_password'
)
\gexec

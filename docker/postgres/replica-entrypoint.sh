#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} == 0 ]]; then
	mkdir -p "${PGDATA}"
	chown -R postgres:postgres "${PGDATA}"
	chmod 0700 "${PGDATA}"
	exec gosu postgres "${BASH_SOURCE[0]}" "$@"
fi

backup_complete="${PGDATA}/.basebackup-complete"

if [[ ! -s "${PGDATA}/PG_VERSION" || ! -f ${backup_complete} ]]; then
	find "${PGDATA}" -mindepth 1 -delete
	pg_basebackup \
		--dbname="host=postgres-primary port=5432 user=${POSTGRES_REPLICATION_USER} password=${POSTGRES_REPLICATION_PASSWORD} application_name=postgres-replica" \
		--pgdata="${PGDATA}" \
		--wal-method=stream \
		--write-recovery-conf \
		--checkpoint=fast
	touch "${backup_complete}"
fi

exec docker-entrypoint.sh postgres

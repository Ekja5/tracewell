#!/bin/bash
# The application role must NOT be a superuser: row-level security is what separates tenants.
set -e
psql -v ON_ERROR_STOP=1 --username postgres <<SQL
CREATE ROLE orthoapp LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${APP_DB_PASSWORD}';
CREATE DATABASE tracewell OWNER orthoapp;
SQL

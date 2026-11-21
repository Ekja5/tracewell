CREATE ROLE orthoapp LOGIN PASSWORD 'orthoapp_local_only' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE tracewell OWNER orthoapp;
CREATE DATABASE tracewell_test OWNER orthoapp;

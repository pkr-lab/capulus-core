CREATE TABLE devices
(
    id                  VARCHAR(255) NOT NULL,
    identity_cert       TEXT         NULL,
    serial_number       VARCHAR(127) NULL,
    unlock_token        BYTEA         NULL,
    unlock_token_at     TIMESTAMP    NULL,
    authenticate        TEXT         NOT NULL,
    authenticate_at     TIMESTAMP    NOT NULL,
    token_update        TEXT         NULL,
    token_update_at     TIMESTAMP    NULL,
    bootstrap_token_b64 TEXT         NULL,
    bootstrap_token_at  TIMESTAMP    NULL,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CHECK (identity_cert IS NULL OR SUBSTRING(identity_cert FROM 1 FOR 27) = '-----BEGIN CERTIFICATE-----'),
    CHECK (serial_number IS NULL OR serial_number != ''),
    CHECK (unlock_token IS NULL OR LENGTH(unlock_token) > 0),
    CHECK (authenticate != ''),
    CHECK (token_update IS NULL OR token_update != ''),
    CHECK (bootstrap_token_b64 IS NULL OR bootstrap_token_b64 != '')
);
CREATE INDEX serial_number ON devices (serial_number);
CREATE TABLE users
(
    id                          VARCHAR(255) NOT NULL,
    device_id                   VARCHAR(255) NOT NULL,
    user_short_name             VARCHAR(255) NULL,
    user_long_name              VARCHAR(255) NULL,
    token_update                TEXT         NULL,
    token_update_at             TIMESTAMP    NULL,
    user_authenticate           TEXT         NULL,
    user_authenticate_at        TIMESTAMP    NULL,
    user_authenticate_digest    TEXT         NULL,
    user_authenticate_digest_at TIMESTAMP    NULL,
    created_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, device_id),
    UNIQUE (id),
    FOREIGN KEY (device_id)
        REFERENCES devices (id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK (user_short_name IS NULL OR user_short_name != ''),
    CHECK (user_long_name IS NULL OR user_long_name != ''),
    CHECK (token_update IS NULL OR token_update != ''),
    CHECK (user_authenticate IS NULL OR user_authenticate != ''),
    CHECK (user_authenticate_digest IS NULL OR user_authenticate_digest != '')
);
CREATE TABLE enrollments
(
    id                 VARCHAR(255) NOT NULL,
    device_id          VARCHAR(255) NOT NULL,
    user_id            VARCHAR(255) NULL,
    type               VARCHAR(31)  NOT NULL,
    topic              VARCHAR(255) NOT NULL,
    push_magic         VARCHAR(127) NOT NULL,
    token_hex          VARCHAR(255) NOT NULL,
    enabled            BOOLEAN      NOT NULL DEFAULT TRUE,
    token_update_tally INTEGER      NOT NULL DEFAULT 1,
    last_seen_at       TIMESTAMP    NOT NULL,
    created_at         TIMESTAMP             DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMP             DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CHECK (id != ''),
    FOREIGN KEY (device_id)
        REFERENCES devices (id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (user_id)
        REFERENCES users (id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    UNIQUE (user_id),
    CHECK (type != ''),
    CHECK (topic != ''),
    CHECK (push_magic != ''),
    CHECK (token_hex != '')
);
CREATE INDEX idx_type ON enrollments (type);
CREATE TABLE commands
(
    command_uuid VARCHAR(127) NOT NULL,
    request_type VARCHAR(63)  NOT NULL,
    command      TEXT         NOT NULL,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (command_uuid),
    CHECK (command_uuid != ''),
    CHECK (request_type != ''),
    CHECK (SUBSTRING(command FROM 1 FOR 5) = '<?xml')
);
CREATE TABLE command_results
(
    id            VARCHAR(255) NOT NULL,
    command_uuid  VARCHAR(127) NOT NULL,
    status        VARCHAR(31)  NOT NULL,
    result        TEXT         NOT NULL,
    not_now_at    TIMESTAMP    NULL,
    not_now_tally INTEGER      NOT NULL DEFAULT 0,
    created_at    TIMESTAMP             DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP             DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, command_uuid),
    FOREIGN KEY (id)
        REFERENCES enrollments (id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (command_uuid)
        REFERENCES commands (command_uuid)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CHECK (status != ''),
    CHECK (SUBSTRING(result FROM 1 FOR 5) = '<?xml')
);
CREATE INDEX idx_status ON command_results (status);
CREATE TABLE enrollment_queue
(
    id           VARCHAR(255) NOT NULL,
    command_uuid VARCHAR(127) NOT NULL,
    active       BOOLEAN      NOT NULL DEFAULT TRUE,
    priority     SMALLINT     NOT NULL DEFAULT 0,
    created_at   TIMESTAMP             DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP             DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, command_uuid),
    FOREIGN KEY (id)
        REFERENCES enrollments (id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (command_uuid)
        REFERENCES commands (command_uuid)
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE OR REPLACE VIEW view_queue AS
SELECT q.id,
       q.created_at,
       q.active,
       q.priority,
       c.command_uuid,
       c.request_type,
       c.command,
       r.updated_at AS result_updated_at,
       r.status,
       r.result
FROM enrollment_queue AS q
         INNER JOIN commands AS c
                    ON q.command_uuid = c.command_uuid
         LEFT JOIN command_results r
                   ON r.command_uuid = q.command_uuid AND r.id = q.id
ORDER BY q.priority DESC,
         q.created_at;
CREATE TABLE push_certs
(
    topic       VARCHAR(255) NOT NULL,
    cert_pem    TEXT         NOT NULL,
    key_pem     TEXT         NOT NULL,
    stale_token INTEGER      NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (topic),
    CHECK (topic != ''),
    CHECK (SUBSTRING(cert_pem FROM 1 FOR 27) = '-----BEGIN CERTIFICATE-----'),
    CHECK (SUBSTRING(key_pem FROM 1 FOR 5) = '-----')
);
CREATE TABLE cert_auth_associations
(
    id         VARCHAR(255) NOT NULL,
    sha256     CHAR(64)     NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, sha256),
    CHECK (id != ''),
    CHECK (sha256 != '')
);
CREATE FUNCTION update_current_timestamp()
    RETURNS TRIGGER AS
    $$
BEGIN
    NEW.updated_at = now();
RETURN NEW;
END;
$$ language 'plpgsql';
CREATE TRIGGER update_at_to_current_timestamp BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE PROCEDURE update_current_timestamp();
CREATE TRIGGER update_at_to_current_timestamp BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE PROCEDURE update_current_timestamp();
CREATE TRIGGER update_at_to_current_timestamp BEFORE UPDATE ON enrollments
    FOR EACH ROW EXECUTE PROCEDURE update_current_timestamp();
CREATE TRIGGER update_at_to_current_timestamp BEFORE UPDATE ON commands
    FOR EACH ROW EXECUTE PROCEDURE update_current_timestamp();
CREATE TRIGGER update_at_to_current_timestamp BEFORE UPDATE ON command_results
    FOR EACH ROW EXECUTE PROCEDURE update_current_timestamp();
CREATE TRIGGER update_at_to_current_timestamp BEFORE UPDATE ON enrollment_queue
    FOR EACH ROW EXECUTE PROCEDURE update_current_timestamp();
CREATE TRIGGER update_at_to_current_timestamp BEFORE UPDATE ON push_certs
    FOR EACH ROW EXECUTE PROCEDURE update_current_timestamp();
CREATE TRIGGER update_at_to_current_timestamp BEFORE UPDATE ON cert_auth_associations
    FOR EACH ROW EXECUTE PROCEDURE update_current_timestamp();

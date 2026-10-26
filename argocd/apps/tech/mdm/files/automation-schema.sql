CREATE SCHEMA automation;

CREATE TABLE automation.setting (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automation.profile_state (
    name       text PRIMARY KEY,
    enabled    boolean NOT NULL DEFAULT true,
    version    integer NOT NULL DEFAULT 1,
    template   text NOT NULL,
    params     jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automation.device_profile (
    enrollment_id text NOT NULL,
    profile_name  text NOT NULL REFERENCES automation.profile_state (name) ON DELETE CASCADE,
    version       integer NOT NULL,
    state         text NOT NULL,
    command_uuid  text,
    claimed_at    timestamptz NOT NULL DEFAULT now(),
    sent_at       timestamptz,
    PRIMARY KEY (enrollment_id, profile_name)
);

CREATE TABLE automation.expiry_notice (
    item      text NOT NULL,
    expiry    date NOT NULL,
    threshold integer NOT NULL,
    sent_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (item, expiry, threshold)
);

CREATE TABLE automation.alert_state (
    check_name    text PRIMARY KEY,
    failing_since timestamptz NOT NULL,
    last_notified timestamptz NOT NULL,
    detail        text
);

GRANT USAGE ON SCHEMA automation TO mdmauto;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA automation TO mdmauto;
GRANT USAGE ON SCHEMA public TO mdmauto;
GRANT SELECT (id, device_id, type, enabled, token_update_tally, last_seen_at) ON public.enrollments TO mdmauto;
GRANT SELECT (id, serial_number) ON public.devices TO mdmauto;
GRANT SELECT (topic, cert_pem, updated_at) ON public.push_certs TO mdmauto;

INSERT INTO automation.setting (key, value)
VALUES ('dep_name', :'depname'),
       ('dep_profile_json', :'depprofile');

INSERT INTO automation.profile_state (name, template, params)
VALUES ('lockscreen',
        :'lockscreentemplate',
        jsonb_build_object(
            'TEXT', :'lockscreentext',
            'IDENTIFIER', :'profileprefix' || '.lockscreen',
            'PAYLOAD_UUID', '544b6bc0-7381-400f-b57c-beb2a74bf33b',
            'PROFILE_UUID', 'e3907677-1014-4be8-931c-6591bdb064a2'
        ));

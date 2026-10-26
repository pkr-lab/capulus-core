CREATE SCHEMA automation;

CREATE TABLE automation.setting (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automation.profile_state (
    name       text PRIMARY KEY,
    kind       text NOT NULL DEFAULT 'profile',
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

CREATE TABLE automation.app_catalog (
    adam_id   text PRIMARY KEY,
    name      text NOT NULL,
    bundle_id text NOT NULL,
    enabled   boolean NOT NULL DEFAULT true,
    added_at  timestamptz NOT NULL DEFAULT now()
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

INSERT INTO automation.app_catalog (adam_id, name, bundle_id)
VALUES ('1625396347', 'ntfy', 'io.heckel.ntfy'),
       ('1659881569', 'DLRG Trainer', 'app.dlrg.trainer'),
       ('1113153706', 'Microsoft Teams', 'com.microsoft.skype.teams');

INSERT INTO automation.profile_state (name, template, params)
SELECT 'app-allowlist',
       :'allowlisttemplate',
       jsonb_build_object(
           'IDENTIFIER', :'profileprefix' || '.allowlist',
           'PAYLOAD_UUID', '422ad897-3af7-4854-839a-ef10d7be212b',
           'PROFILE_UUID', '79711357-640e-4880-991c-ccefcc8808e6',
           'SYSTEM_APPS', s.system_apps,
           'ALLOWED_APPS', (
               SELECT jsonb_agg(b ORDER BY b)
               FROM (SELECT jsonb_array_elements_text(s.system_apps) AS b
                     UNION
                     SELECT bundle_id FROM automation.app_catalog WHERE enabled) u
           )
       )
FROM (SELECT '["com.apple.AppStore","com.apple.Preferences","com.apple.mobilesafari","com.apple.mobileslideshow","com.apple.DocumentsApp","com.apple.mobiletimer"]'::jsonb AS system_apps) s;

INSERT INTO automation.profile_state (name, template, params)
VALUES ('wallpaper-lock',
        :'wallpaperlocktemplate',
        jsonb_build_object(
            'IDENTIFIER', :'profileprefix' || '.wallpaperlock',
            'PAYLOAD_UUID', '803aa950-3ebf-4acf-ad2d-dcf5ba483d6e',
            'PROFILE_UUID', 'd6e84732-cec5-4fe4-b073-4930160b9207'
        ));

\set wallpaperb64 `base64 -w0 /init-files/ipad-wallpaper.png`

INSERT INTO automation.profile_state (name, kind, template, params)
VALUES ('wallpaper', 'wallpaper', '', jsonb_build_object('IMAGE_B64', :'wallpaperb64', 'WHERE', 3));

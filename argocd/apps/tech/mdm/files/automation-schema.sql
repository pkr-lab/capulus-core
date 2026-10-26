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
    config    jsonb NOT NULL DEFAULT '{}'::jsonb,
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
GRANT SELECT (id, command_uuid, status, result) ON public.command_results TO mdmauto;
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

INSERT INTO automation.app_catalog (adam_id, name, bundle_id, config)
VALUES ('1625396347', 'ntfy', 'io.heckel.ntfy', '{}'::jsonb),
       ('983156458', 'Microsoft Authenticator', 'com.microsoft.azureauthenticator', '{}'::jsonb),
       ('1659881569', 'DLRG Trainer', 'app.dlrg.trainer', '{}'::jsonb),
       ('1113153706', 'Microsoft Teams', 'com.microsoft.skype.teams', '{}'::jsonb),
       ('1137397744', 'Bitwarden Passwortmanager', 'com.8bit.bitwarden', jsonb_build_object('baseEnvironmentUrl', 'https://vault-tech.pke-lab.de'));

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
FROM (SELECT '["com.apple.AppStore","com.apple.Preferences","com.apple.mobilesafari","com.apple.mobileslideshow","com.apple.DocumentsApp","com.apple.mobiletimer","com.apple.webapp"]'::jsonb AS system_apps) s;

INSERT INTO automation.profile_state (name, template, params)
VALUES ('app-blocklist',
        :'blocklisttemplate',
        jsonb_build_object(
            'IDENTIFIER', :'profileprefix' || '.blocklist',
            'PAYLOAD_UUID', 'a99aab28-4708-4ad2-95ad-ea69d91f5709',
            'PROFILE_UUID', '91cb9a10-c975-4612-829d-c103c4e6a943',
            'BLOCKED_APPS', jsonb_build_array('com.apple.mobilephone', 'com.apple.MobileSMS', 'com.apple.camera')
        ));

INSERT INTO automation.profile_state (name, template, params)
VALUES ('webclips',
        :'webclipstemplate',
        jsonb_build_object(
            'IDENTIFIER', :'profileprefix' || '.webclips',
            'PROFILE_UUID', 'b8582656-abe4-4f10-971e-3ec138980ca3',
            'ISC_UUID', '2ad08709-cb6e-420e-86da-eddbf05fab7e',
            'ISC_URL', 'https://dlrg.net/apps/training',
            'L1_UUID', '065bc162-037d-4e3d-9e5c-0041107de122',
            'L1_URL', 'https://dlrgorg.sharepoint.com/:l:/r/sites/andernach.ausbildung-Ausbildungundco/Lists/Gruppe_1_Stunde_1?e=WGaw5f',
            'L2_UUID', '66e13375-448c-4b09-b8ea-d2ba6b830c2a',
            'L2_URL', 'https://dlrgorg.sharepoint.com/:l:/r/sites/andernach.ausbildung-Ausbildungundco/Lists/Gruppe_1_Stunde_2?e=rdQeeo',
            'L3_UUID', '3e4e6176-2c78-4488-bd07-67f8fc06df3e',
            'L3_URL', 'https://dlrgorg.sharepoint.com/:l:/r/sites/andernach.ausbildung/Lists/Gruppe_2_Stunde_1?e=xsV16J',
            'L4_UUID', '247d9463-d92c-4d73-9b44-642744bb9b4d',
            'L4_URL', 'https://dlrgorg.sharepoint.com/:l:/r/sites/andernach.ausbildung/Lists/Gruppe_2_Stunde_2?e=YLlhW9'
        ));

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

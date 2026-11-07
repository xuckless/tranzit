-- Demo seed for tranzit_user. Idempotent: ./demo.sh up re-runs it so the sample
-- planner events always sit on today and the coming week (Calgary time).
-- Usage: psql -v demo_user=<uuid> -f seed.sql
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO user_info (user_id, username, email, name, is_guest, city, country)
VALUES (:'demo_user', 'demo', 'demo@tranzit.local', 'Demo Rider', FALSE, 'Calgary', 'Canada')
ON CONFLICT (user_id) DO NOTHING;

-- Saved places: category_code is "<user_id>:<slug>" (lib/savedPlaces.ts slugCode),
-- category_icon matches styles/categoryStyle.ts.
INSERT INTO user_defined_default_categories (category_code, user_id, category_name, category_icon) VALUES
  (:'demo_user' || ':home',     :'demo_user', 'Home',     'home'),
  (:'demo_user' || ':work',     :'demo_user', 'Work',     'briefcase'),
  (:'demo_user' || ':school',   :'demo_user', 'School',   'university'),
  (:'demo_user' || ':gym',      :'demo_user', 'Gym',      'dumbbell'),
  (:'demo_user' || ':shopping', :'demo_user', 'Shopping', 'shopping-bag'),
  (:'demo_user' || ':park',     :'demo_user', 'Park',     'tree')
ON CONFLICT (category_code) DO NOTHING;

INSERT INTO saved_addresses (user_id, category_code, full_formatted_address, city, country, lat, lng) VALUES
  (:'demo_user', :'demo_user' || ':home',     '1121 Kensington Rd NW, Calgary, AB',        'Calgary', 'Canada', 51.05260, -114.09170),
  (:'demo_user', :'demo_user' || ':work',     'The Bow, 500 Centre St SE, Calgary, AB',    'Calgary', 'Canada', 51.04760, -114.06240),
  (:'demo_user', :'demo_user' || ':school',   'University of Calgary, Calgary, AB',        'Calgary', 'Canada', 51.07820, -114.13720),
  (:'demo_user', :'demo_user' || ':gym',      'Repsol Sport Centre, 2225 Macleod Trl SE',  'Calgary', 'Canada', 51.03840, -114.06010),
  (:'demo_user', :'demo_user' || ':shopping', 'CF Chinook Centre, 6455 Macleod Trl SW',    'Calgary', 'Canada', 50.99830, -114.07310),
  (:'demo_user', :'demo_user' || ':park',     'Prince''s Island Park, Calgary, AB',        'Calgary', 'Canada', 51.05460, -114.07150)
ON CONFLICT (user_id, category_code) DO NOTHING;

-- Planner events: drop the previous seed and re-create it relative to today.
DELETE FROM user_defined_events WHERE user_id = :'demo_user' AND event_id LIKE 'seed:%';

CREATE TEMP TABLE seed_events (
  event_id text, name text, description text,
  day_offset int, start_hm text, end_day_offset int, end_hm text,
  location text, lat double precision, lng double precision, rrule text
) ON COMMIT DROP;

INSERT INTO seed_events VALUES
  ('seed:lecture',  'Lecture — CPSC 457', 'Operating systems, ICT 102', 0, '09:00', 0, '10:30',
     'University of Calgary', 51.0782, -114.1372, 'FREQ=WEEKLY'),
  ('seed:lunch',    'Lunch with Sam', 'Stephen Avenue patio', 0, '12:00', 0, '13:00',
     'Stephen Avenue Walk, Calgary', 51.0457, -114.0659, NULL),
  ('seed:dentist',  'Dentist', 'Check-up', 0, '12:30', 0, '13:30',
     'Mission, Calgary', 51.0336, -114.0711, NULL),
  -- Weekday series: day_offset 0 is replaced below so it starts on a weekday.
  ('seed:gym',      'Gym', 'Leg day', 0, '17:30', 0, '18:30',
     'Repsol Sport Centre', 51.0384, -114.0601, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'),
  ('seed:flames',   'Flames game', 'Scotiabank Saddledome', 0, '19:00', 0, '22:00',
     'Scotiabank Saddledome, Calgary', 51.0374, -114.0519, NULL),
  ('seed:chinook',  'Shopping at Chinook', NULL, 1, '10:00', 1, '12:00',
     'CF Chinook Centre', 50.9983, -114.0731, NULL),
  ('seed:library',  'Study session', 'Central Library, level 3', 2, '14:00', 2, '17:00',
     'Calgary Central Library', 51.0453, -114.0547, NULL),
  ('seed:volunteer','Folk Fest volunteering', 'All-day shifts', 3, '00:00', 5, '00:00',
     'Prince''s Island Park', 51.0546, -114.0715, NULL),
  ('seed:banff',    'Banff weekend', 'Leaving from downtown', 4, '17:00', 6, '15:00',
     'Banff, AB', NULL, NULL, NULL);

-- Start the weekday-only gym series on today if it's a weekday, else next Monday.
UPDATE seed_events
   SET day_offset = CASE extract(isodow FROM now() AT TIME ZONE 'America/Edmonton')
                      WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END,
       end_day_offset = CASE extract(isodow FROM now() AT TIME ZONE 'America/Edmonton')
                      WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END
 WHERE event_id = 'seed:gym';

INSERT INTO user_defined_events
  (event_id, user_id, name, description, start_time, end_time, timezone,
   location, location_lat, location_lng, recurrence_rule)
SELECT
  event_id, :'demo_user', name, description,
  ((now() AT TIME ZONE 'America/Edmonton')::date + day_offset + start_hm::time) AT TIME ZONE 'America/Edmonton',
  ((now() AT TIME ZONE 'America/Edmonton')::date + end_day_offset + end_hm::time) AT TIME ZONE 'America/Edmonton',
  'America/Edmonton', location, lat, lng, rrule
FROM seed_events;

INSERT INTO user_calendar (user_id, event_id, time_critical)
SELECT :'demo_user', event_id, event_id IN ('seed:lecture', 'seed:flames')
FROM seed_events
ON CONFLICT (user_id, event_id) DO NOTHING;

COMMIT;

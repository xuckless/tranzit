-- tranzit-user-db schema (user data)
--
-- snake_case identifiers. Layered on top of the original DDL:
--   * FK indexes (Postgres does not auto-index foreign keys)
--   * updated_at triggers (a bare DEFAULT only fires on INSERT)
--   * integrity CHECKs + uniqueness constraints
--   * design fixes: user_friendships.user_id dropped, age -> date_of_birth, SERIAL -> IDENTITY
--   * cross-user integrity via composite FK on saved_addresses
--
-- Apply: docker exec -i tranzit-user-db psql -U tranzit-user -d tranzit-user -v ON_ERROR_STOP=1 < schema.sql

BEGIN;

-- Sets updated_at = now() on every UPDATE (DEFAULT only covers INSERT).
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE user_info (
  user_id             VARCHAR(255) PRIMARY KEY,
  username            VARCHAR(255) UNIQUE NOT NULL,
  email               VARCHAR(255),
  name                VARCHAR(255),
  date_of_birth       DATE,
  avatar              VARCHAR(255),
  is_guest            BOOLEAN NOT NULL DEFAULT FALSE,
  subscription_status VARCHAR(50) DEFAULT 'FREE',
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  billing_date        DATE,
  country             VARCHAR(100),
  city                VARCHAR(100)
);
CREATE TRIGGER trg_user_info_updated BEFORE UPDATE ON user_info
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_defined_default_categories (
  category_code VARCHAR(255) PRIMARY KEY,
  user_id       VARCHAR(255) NOT NULL REFERENCES user_info(user_id) ON DELETE CASCADE,
  category_name VARCHAR(255) NOT NULL,
  category_icon VARCHAR(255) NOT NULL,
  UNIQUE (user_id, category_code)   -- enables the same-user composite FK from saved_addresses
);
CREATE INDEX idx_categories_user ON user_defined_default_categories(user_id);

CREATE TABLE user_defined_default_themes (
  theme_id         VARCHAR(255) PRIMARY KEY,
  user_id          VARCHAR(255) NOT NULL REFERENCES user_info(user_id) ON DELETE CASCADE,
  theme_name       VARCHAR(255) NOT NULL,
  config_file_link VARCHAR(255) NOT NULL
);
CREATE INDEX idx_themes_user ON user_defined_default_themes(user_id);

CREATE TABLE user_defined_events (
  event_id        VARCHAR(255) PRIMARY KEY,
  user_id         VARCHAR(255) NOT NULL REFERENCES user_info(user_id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  start_time      TIMESTAMPTZ NOT NULL,
  end_time        TIMESTAMPTZ NOT NULL,
  timezone        VARCHAR(100),
  location        VARCHAR(255),
  location_lat    DOUBLE PRECISION,
  location_lng    DOUBLE PRECISION,
  place_id        VARCHAR(255),
  recurrence_rule VARCHAR(255),
  travel_time     INTEGER,
  CHECK (end_time > start_time)
);
CREATE INDEX idx_events_user ON user_defined_events(user_id);

CREATE TABLE cached_pre_routes (
  route_id                   VARCHAR(255) PRIMARY KEY,
  event_id                   VARCHAR(255) NOT NULL REFERENCES user_defined_events(event_id) ON DELETE CASCADE,
  user_id                    VARCHAR(255) NOT NULL REFERENCES user_info(user_id) ON DELETE CASCADE,
  route_engine_json_response JSONB NOT NULL,
  travel_time                INTEGER
);
CREATE INDEX idx_cached_routes_event ON cached_pre_routes(event_id);

CREATE TABLE posts (
  post_id      VARCHAR(255) PRIMARY KEY,
  event_id     VARCHAR(255) NOT NULL REFERENCES user_defined_events(event_id) ON DELETE CASCADE,
  caption      TEXT,
  content_link VARCHAR(500) NOT NULL
);
CREATE INDEX idx_posts_event ON posts(event_id);

CREATE TABLE saved_addresses (
  user_id                VARCHAR(255) NOT NULL,
  category_code          VARCHAR(255) NOT NULL,
  full_formatted_address TEXT NOT NULL,
  city                   VARCHAR(100),
  country                VARCHAR(100),
  lat                    DECIMAL(10,8),
  lng                    DECIMAL(11,8),
  google_place_id        VARCHAR(255),
  PRIMARY KEY (user_id, category_code),
  FOREIGN KEY (user_id) REFERENCES user_info(user_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, category_code)
    REFERENCES user_defined_default_categories(user_id, category_code) ON DELETE CASCADE
);

CREATE TABLE user_themes (
  user_id        VARCHAR(255) NOT NULL REFERENCES user_info(user_id) ON DELETE CASCADE,
  theme_id       VARCHAR(255) NOT NULL REFERENCES user_defined_default_themes(theme_id) ON DELETE CASCADE,
  current_picked BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (user_id, theme_id)
);
CREATE INDEX idx_user_themes_theme ON user_themes(theme_id);
CREATE UNIQUE INDEX uq_user_one_current_theme ON user_themes(user_id) WHERE current_picked;

CREATE TABLE user_history (
  history_id                         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id                            VARCHAR(255) NOT NULL REFERENCES user_info(user_id) ON DELETE CASCADE,
  origin_lat                         DECIMAL(10,8),
  origin_lng                         DECIMAL(11,8),
  origin_address                     TEXT,
  destination_full_formatted_address TEXT,
  destination_city                   VARCHAR(100),
  destination_country                VARCHAR(100),
  destination_lat                    DECIMAL(10,8),
  destination_lng                    DECIMAL(11,8),
  google_place_id                    VARCHAR(255),
  category_code                      VARCHAR(255) REFERENCES user_defined_default_categories(category_code) ON DELETE SET NULL,
  date_time                          TIMESTAMPTZ DEFAULT now(),
  bus_number                         VARCHAR(100),
  common_name                        VARCHAR(255)  -- business / display name (e.g. "Calgary Tower")
);
CREATE INDEX idx_history_user ON user_history(user_id);
CREATE INDEX idx_history_category ON user_history(category_code);

CREATE TABLE user_calendar (
  calendar_entry_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id             VARCHAR(255) NOT NULL REFERENCES user_info(user_id) ON DELETE CASCADE,
  event_id            VARCHAR(255) NOT NULL REFERENCES user_defined_events(event_id) ON DELETE CASCADE,
  time_critical       BOOLEAN DEFAULT FALSE,
  cached_pre_route_id VARCHAR(255) REFERENCES cached_pre_routes(route_id) ON DELETE SET NULL,
  travel_time         INTEGER,
  UNIQUE (user_id, event_id)
);
CREATE INDEX idx_calendar_user ON user_calendar(user_id);
CREATE INDEX idx_calendar_event ON user_calendar(event_id);
CREATE INDEX idx_calendar_route ON user_calendar(cached_pre_route_id);

CREATE TABLE user_posts (
  user_id           VARCHAR(255) NOT NULL REFERENCES user_info(user_id) ON DELETE CASCADE,
  post_id           VARCHAR(255) NOT NULL REFERENCES posts(post_id) ON DELETE CASCADE,
  time_posted       TIMESTAMPTZ DEFAULT now(),
  location_lat      DECIMAL(10,8),
  location_lng      DECIMAL(11,8),
  location_place_id VARCHAR(255),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX idx_user_posts_post ON user_posts(post_id);

CREATE TABLE user_friendships (
  friendship_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requester_id  VARCHAR(255) NOT NULL REFERENCES user_info(user_id) ON DELETE CASCADE,
  addressee_id  VARCHAR(255) NOT NULL REFERENCES user_info(user_id) ON DELETE CASCADE,
  status        VARCHAR(50) CHECK (status IN ('ACTIVE','PENDING','BLOCKED')),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  CHECK (requester_id <> addressee_id)
);
CREATE INDEX idx_friendships_requester ON user_friendships(requester_id);
CREATE INDEX idx_friendships_addressee ON user_friendships(addressee_id);
CREATE UNIQUE INDEX uq_friendship_pair ON user_friendships
  (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));
CREATE TRIGGER trg_friendships_updated BEFORE UPDATE ON user_friendships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;

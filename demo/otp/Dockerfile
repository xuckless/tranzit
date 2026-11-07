# Demo OTP image: builds the Calgary graph on first start (into the otp-data
# volume) and serves it. Unlike services/otp/Dockerfile, nothing has to exist on
# the host first — the jar is baked in, GTFS + OSM are fetched at first run.
FROM eclipse-temurin:21-jre

ARG OTP_VERSION=2.6.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /opt/otp-shaded.jar \
      "https://repo1.maven.org/maven2/org/opentripplanner/otp/${OTP_VERSION}/otp-${OTP_VERSION}-shaded.jar"

COPY build-config.json router-config.json entrypoint.sh /opt/otp/
RUN chmod +x /opt/otp/entrypoint.sh

ENV OTP_DATA=/data JAVA_BUILD_OPTS="-Xmx4G" JAVA_OPTS="-Xmx3G"
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/opt/otp/entrypoint.sh"]

# OTP2 server image. Expects a pre-built graph.obj (run ./build.sh on the host first,
# or build inside CI) plus the config files. Bakes the graph into the image so there is
# no cold-start graph fetch — important for predictable latency on Cloud Run / a VM.
FROM eclipse-temurin:21-jre

ARG OTP_VERSION=2.6.0
WORKDIR /var/otp

# OTP runtime + the built graph and config. graph.obj must exist before docker build.
COPY otp-${OTP_VERSION}-shaded.jar /var/otp/otp-shaded.jar
COPY graph.obj /var/otp/graph.obj
COPY build-config.json router-config.json /var/otp/

ENV JAVA_OPTS="-Xmx4G"
EXPOSE 8080

# --load reads graph.obj + router-config.json (which starts the GTFS-RT updaters).
ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar /var/otp/otp-shaded.jar --load /var/otp"]

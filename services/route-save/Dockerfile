# syntax=docker/dockerfile:1

# --- build stage ---
FROM golang:1.26 AS build
WORKDIR /src

# Cache deps first.
COPY go.mod go.sum ./
RUN go mod download

# Build a static binary (no CGO) so it runs on a distroless/static base.
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/route-save .

# --- runtime stage ---
# distroless static includes CA certs (needed for HTTPS to the Cloud Run
# siblings) and runs as a non-root user.
FROM gcr.io/distroless/static-debian12:nonroot

# Route Save listens here; override with -e PORT=… at run time.
ENV PORT=8090
EXPOSE 8090

COPY --from=build /out/route-save /route-save
USER nonroot:nonroot
ENTRYPOINT ["/route-save"]

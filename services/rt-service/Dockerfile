FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o tranzit-rt-service .

FROM alpine:3.21
# ca-certificates needed for TLS connections to Supabase and Calgary Open Data API.
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/tranzit-rt-service .
EXPOSE 8080
CMD ["./tranzit-rt-service"]

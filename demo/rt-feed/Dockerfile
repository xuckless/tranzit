FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/rt-feed .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/rt-feed /rt-feed
EXPOSE 8780
ENTRYPOINT ["/rt-feed"]

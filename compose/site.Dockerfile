# Package a static site directory into a Caddy image.
# Build context = the directory to serve:
#   docker buildx build --platform linux/amd64 -f compose/site.Dockerfile -t <tag> --load .
FROM caddy:2-alpine
RUN printf ':80 {\n\troot * /srv\n\ttry_files {path} {path}.html {path}/\n\tfile_server\n}\n' > /etc/caddy/Caddyfile
COPY . /srv

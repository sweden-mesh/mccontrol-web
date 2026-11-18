#!/bin/sh
# Vendor the noble libraries into web/vendor/: download each pinned tarball from the npm
# registry into a fresh empty directory, check it against the registry's sha512 integrity,
# copy the ES modules (not index.js, which only throws), LICENSE and package.json, and rewrite noble-curves' bare
# `@noble/hashes/...` imports to relative paths (a page under script-src 'self' has no
# import map). Nothing in the tarballs is run. Usage: sh scripts/vendor-web.sh
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VENDOR="$ROOT/web/vendor"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# name version sha512 (the registry's dist.integrity, base64)
PINS="hashes 2.4.0 X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==
curves 2.4.0 P4/62zrgfH33CneE3Dn4WhJVA22YUU0eR51wKIan4NVRvwsA0YnPTwWGpNbpuacSujmSFLvyzpyuR30+fbq2Ew==
ciphers 2.4.0 AnjFn0Jv92laAkvMrghlFZq4qQCIN/4DxFV/eooqtC2YTjB7kBeLMS2T9KJX4Dn+ZVXLOwK0lSgqDtx9gvxtiw=="

echo "$PINS" | while read -r name version integrity; do
    tgz="$WORK/$name.tgz"
    curl -sSf -o "$tgz" "https://registry.npmjs.org/@noble/$name/-/$name-$version.tgz"
    got=$(openssl dgst -sha512 -binary "$tgz" | base64 | tr -d '\n')
    if [ "$got" != "$integrity" ]; then
        echo "@noble/$name@$version: sha512 mismatch" >&2
        exit 1
    fi
    mkdir "$WORK/$name"
    tar -xzf "$tgz" -C "$WORK/$name" --no-same-owner --no-same-permissions
    src="$WORK/$name/package"
    dst="$VENDOR/noble-$name"
    rm -rf "$dst"
    mkdir -p "$dst"
    cp "$src/LICENSE" "$src/package.json" "$dst/"
    (cd "$src" && find . -name '*.js' -not -path './src/*' -not -name index.js -print) | while read -r f; do
        mkdir -p "$dst/$(dirname "$f")"
        cp "$src/$f" "$dst/$f"
    done
    echo "@noble/$name@$version sha512-$integrity OK"
done

# noble-curves imports @noble/hashes by package name; point it at the sibling copy.
for f in "$VENDOR"/noble-curves/*.js; do
    sed -i -E "s#^((import|export)[^'\"]* from )'@noble/hashes/#\1'../noble-hashes/#" "$f"
done
for f in "$VENDOR"/noble-curves/abstract/*.js; do
    sed -i -E "s#^((import|export)[^'\"]* from )'@noble/hashes/#\1'../../noble-hashes/#" "$f"
done
if grep -rnE "^(import|export)[^'\"]* from '@" "$VENDOR"; then
    echo "a bare import is left" >&2
    exit 1
fi

# MapLibre GL JS (BSD-3-Clause) for the standard layout's map (W-29d): the same version and the
# same three dist files as the regional template's static/lib/maplibre-gl/, byte for byte. Its
# worker is loaded from beside it through ui/standard/map.js's Trusted Types policy.
ML_VERSION=6.16.0
ML_INTEGRITY=gApO66EMtoDZuio680RUBvskR7ahFd/NNhLN4tBAs+Y7FeT4gQV8zVFgYVMRmFxQznOEzecW19w6xOd9XjZjiA==
tgz="$WORK/maplibre.tgz"
curl -sSf -o "$tgz" "https://registry.npmjs.org/maplibre-gl/-/maplibre-gl-$ML_VERSION.tgz"
got=$(openssl dgst -sha512 -binary "$tgz" | base64 | tr -d '\n')
if [ "$got" != "$ML_INTEGRITY" ]; then
    echo "maplibre-gl@$ML_VERSION: sha512 mismatch" >&2
    exit 1
fi
mkdir "$WORK/maplibre"
tar -xzf "$tgz" -C "$WORK/maplibre" --no-same-owner --no-same-permissions
dst="$VENDOR/maplibre-gl"
rm -rf "$dst"
mkdir -p "$dst"
cp "$WORK/maplibre/package/LICENSE.txt" "$WORK/maplibre/package/dist/maplibre-gl.mjs" \
   "$WORK/maplibre/package/dist/maplibre-gl-worker.mjs" "$WORK/maplibre/package/dist/maplibre-gl.css" "$dst/"
echo "maplibre-gl@$ML_VERSION sha512-$ML_INTEGRITY OK"

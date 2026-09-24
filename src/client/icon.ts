/**
 * Small inline icon (data URI) for the plugin settings card, so the client
 * bundle ships no extra asset files.
 *
 * @module dsh-connect-comate/client/icon
 */

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
  + '<rect width="64" height="64" rx="14" fill="%232b6df6"/>'
  + '<text x="32" y="42" font-family="Segoe UI,Arial,sans-serif" font-size="30" '
  + 'font-weight="700" fill="white" text-anchor="middle">C</text>'
  + '</svg>'

export const COMATE_PLUGIN_ICON = `data:image/svg+xml;utf8,${svg}`

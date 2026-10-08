// SPDX-License-Identifier: GPL-3.0-only
package org.wiijukebox.android;

import org.json.JSONException;
import org.json.JSONObject;

/** A WiiJukebox server, either discovered on the LAN or typed in by hand. */
final class Server {
    final String id;
    final String name;
    final String host;
    final int port;

    Server(String id, String name, String host, int port) {
        this.id = id;
        this.name = name;
        this.host = host;
        this.port = port;
    }

    String url() {
        return "http://" + host + ":" + port + "/";
    }

    String address() {
        return host + ":" + port;
    }

    Server at(String newHost, int newPort) {
        return new Server(id, name, newHost, newPort);
    }

    JSONObject toJson() throws JSONException {
        return new JSONObject().put("id", id).put("name", name).put("host", host).put("port", port);
    }

    static Server fromJson(JSONObject json) {
        return new Server(json.optString("id"), json.optString("name"), json.optString("host"), json.optInt("port"));
    }

    /** Parses "host" or "host:port"; the default is the server's usual port. */
    static Server fromAddress(String text) {
        String trimmed = text.trim().replaceFirst("^https?://", "").replaceAll("/.*$", "");
        if (trimmed.isEmpty()) return null;
        String host = trimmed;
        int port = 4005;
        int colon = trimmed.lastIndexOf(':');
        if (colon > 0 && trimmed.indexOf(':') == colon) {
            host = trimmed.substring(0, colon);
            try {
                port = Integer.parseInt(trimmed.substring(colon + 1));
            } catch (NumberFormatException e) {
                return null;
            }
        }
        if (host.isEmpty() || port < 1 || port > 65535) return null;
        return new Server("", host, host, port);
    }
}

// SPDX-License-Identifier: GPL-3.0-only
package org.wiijukebox.android;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/** Remembers the chosen server by its UUID, so a new address is found again by discovery. */
final class ServerStore {
    private final SharedPreferences prefs;

    ServerStore(Context context) {
        prefs = context.getSharedPreferences("servers", Context.MODE_PRIVATE);
    }

    Server last() {
        String json = prefs.getString("last", null);
        if (json == null) return null;
        try {
            Server server = Server.fromJson(new JSONObject(json));
            return server.host.isEmpty() ? null : server;
        } catch (JSONException e) {
            return null;
        }
    }

    void remember(Server server) {
        try {
            prefs.edit().putString("last", server.toJson().toString()).apply();
        } catch (JSONException e) {
            // Not worth failing a connection over.
        }
    }

    void forget() {
        prefs.edit().remove("last").apply();
    }

    /** Extra discovery ports, for servers that moved off 4005 (comma separated). */
    List<Integer> discoveryPorts() {
        List<Integer> ports = new ArrayList<>();
        ports.add(Discovery.DEFAULT_PORT);
        for (String part : prefs.getString("ports", "").split("[,\\s]+")) {
            try {
                int port = Integer.parseInt(part);
                if (port > 0 && port < 65536 && !ports.contains(port)) ports.add(port);
            } catch (NumberFormatException e) {
                // Ignore anything that is not a port number.
            }
        }
        return ports;
    }

    void setDiscoveryPorts(String text) {
        prefs.edit().putString("ports", text).apply();
    }
}

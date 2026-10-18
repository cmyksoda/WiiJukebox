// SPDX-License-Identifier: GPL-3.0-only
package org.wiijukebox.android;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Remembers recent servers, a found one by its UUID so a new address is found again by discovery. */
final class ServerStore {
    private static final int RECENT = 6;
    private final SharedPreferences prefs;

    ServerStore(Context context) {
        prefs = context.getSharedPreferences("servers", Context.MODE_PRIVATE);
    }

    Server last() {
        List<Server> recent = recent();
        return recent.isEmpty() ? null : recent.get(0);
    }

    /** Newest first. */
    List<Server> recent() {
        List<Server> servers = new ArrayList<>();
        try {
            JSONArray list = new JSONArray(prefs.getString("recent", "[]"));
            for (int i = 0; i < list.length(); i++) {
                Server server = Server.fromJson(list.getJSONObject(i));
                if (!server.host.isEmpty()) servers.add(server);
            }
            // Older versions kept only the last server.
            String last = prefs.getString("last", null);
            if (servers.isEmpty() && last != null) {
                Server server = Server.fromJson(new JSONObject(last));
                if (!server.host.isEmpty()) servers.add(server);
            }
        } catch (JSONException e) {
            // A damaged list starts over.
        }
        return servers;
    }

    void remember(Server server) {
        List<Server> servers = recent();
        servers.removeIf(server::sameAs);
        servers.add(0, server);
        save(servers);
    }

    void forget(Server server) {
        List<Server> servers = recent();
        servers.removeIf(server::sameAs);
        save(servers);
    }

    private void save(List<Server> servers) {
        JSONArray list = new JSONArray();
        try {
            for (Server server : servers.subList(0, Math.min(RECENT, servers.size()))) list.put(server.toJson());
        } catch (JSONException e) {
            return;
        }
        prefs.edit().putString("recent", list.toString()).remove("last").apply();
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

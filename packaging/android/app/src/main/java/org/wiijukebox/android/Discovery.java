// SPDX-License-Identifier: GPL-3.0-only
package org.wiijukebox.android;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The server's UDP discovery protocol (see src/client/discovery.js): broadcast
 * "WIIJUKEBOX_DISCOVER\t1\t<nonce>\n"; each server answers the sender with
 * "WIIJUKEBOX\t1\t<nonce>\t<uuid>\t<http port>\t<name>\t<mount>\n".
 */
final class Discovery {
    static final int DEFAULT_PORT = 4005;

    private static final Pattern REPLY = Pattern.compile(
            "^WIIJUKEBOX\t1\t([a-f0-9]{16})\t([a-f0-9-]{36})\t(\\d{1,5})\t([^\t\n]*)\t([^\t\n]*)\n?$");

    private Discovery() {}

    /** Sends probes for a while and returns every server that answered, keyed by its UUID. */
    static List<Server> scan(List<Integer> discoveryPorts, int listenMillis) {
        Map<String, Server> found = new LinkedHashMap<>();
        String nonce = randomNonce();
        byte[] probe = ("WIIJUKEBOX_DISCOVER\t1\t" + nonce + "\n").getBytes(StandardCharsets.US_ASCII);
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            socket.setSoTimeout(250);
            long deadline = System.currentTimeMillis() + listenMillis;
            long nextProbe = 0;
            byte[] buffer = new byte[1024];
            while (System.currentTimeMillis() < deadline) {
                if (System.currentTimeMillis() >= nextProbe) {
                    sendProbes(socket, probe, discoveryPorts);
                    nextProbe = System.currentTimeMillis() + 700;
                }
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                try {
                    socket.receive(packet);
                } catch (SocketTimeoutException e) {
                    continue;
                }
                Server server = parse(packet, nonce);
                if (server != null) found.put(server.id, server);
            }
        } catch (java.io.IOException e) {
            // No network: report whatever was found, which is nothing.
        }
        return new ArrayList<>(found.values());
    }

    private static void sendProbes(DatagramSocket socket, byte[] probe, List<Integer> ports) {
        List<InetAddress> targets = new ArrayList<>();
        try {
            targets.add(InetAddress.getByName("255.255.255.255"));
            for (NetworkInterface nic : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nic.isUp() || nic.isLoopback()) continue;
                for (InterfaceAddress address : nic.getInterfaceAddresses()) {
                    if (address.getBroadcast() != null) targets.add(address.getBroadcast());
                }
            }
        } catch (java.io.IOException e) {
            // Fall back to whatever targets were collected.
        }
        for (InetAddress target : targets) {
            for (int port : ports) {
                try {
                    socket.send(new DatagramPacket(probe, probe.length, target, port));
                } catch (java.io.IOException e) {
                    // One unreachable interface should not stop the others.
                }
            }
        }
    }

    static Server parse(DatagramPacket packet, String nonce) {
        String text = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
        Matcher match = REPLY.matcher(text);
        if (!match.matches() || !match.group(1).equals(nonce)) return null;
        int port = Integer.parseInt(match.group(3));
        if (port < 1 || port > 65535) return null;
        try {
            String name = URLDecoder.decode(match.group(4), "UTF-8");
            return new Server(match.group(2), name.isEmpty() ? "WiiJukebox" : name,
                    packet.getAddress().getHostAddress(), port);
        } catch (java.io.UnsupportedEncodingException | IllegalArgumentException e) {
            return null;
        }
    }

    private static String randomNonce() {
        byte[] bytes = new byte[8];
        new SecureRandom().nextBytes(bytes);
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format("%02x", b));
        return out.toString();
    }
}

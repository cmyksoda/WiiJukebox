// SPDX-License-Identifier: GPL-3.0-only
package org.wiijukebox.android;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;

/** Finds WiiJukebox servers on the LAN and shows the chosen one's controller page. */
public final class MainActivity extends Activity implements Chooser.Listener {
    private ServerStore store;
    private Ui ui;
    private FrameLayout root;
    private WebView web;
    private Chooser chooser;
    private Fullscreen fullscreen;
    private Server current;
    private int generation;
    // What the page last said about itself, for the system bars' icons; pages from older servers say nothing.
    private int pageColor;
    private Boolean pageDark;
    private volatile String pageInsets = "{\"top\":0,\"bottom\":0}";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        store = new ServerStore(this);
        ui = new Ui(this);
        // The page draws under the status and navigation bars and pads itself (see insets()).
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        buildViews();
        applySystemBars();
        if (savedInstanceState != null && savedInstanceState.getString("server") != null) {
            current = Server.fromAddress(savedInstanceState.getString("server"));
        }
        Server last = current != null ? current : store.last();
        if (last == null) showChooser(null, true);
        else connect(last, true);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (current != null) out.putString("server", current.address());
    }

    @Override
    public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        applySystemBars();
        chooser.render();
    }

    @Override
    protected void onDestroy() {
        generation++;
        web.destroy();
        super.onDestroy();
    }

    // --- views -----------------------------------------------------------

    private void buildViews() {
        root = new FrameLayout(this);
        pageColor = ui.color(R.color.surface);
        root.setBackgroundColor(pageColor);

        // Debug builds let a computer's Chrome (chrome://inspect) look inside the page.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setVisibility(View.GONE);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= 33) settings.setAlgorithmicDarkeningAllowed(false);
        web.setBackgroundColor(pageColor);
        web.addJavascriptInterface(new Bridge(), "WiiJukeboxApp");
        fullscreen = new Fullscreen();
        web.setWebChromeClient(fullscreen);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (current != null && current.host.equals(uri.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (RuntimeException e) {
                    // No app to open it; ignore the tap.
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && current != null) {
                    showChooser(getString(R.string.unreachable, current.address()), true);
                }
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        chooser = new Chooser(this, ui, this);
        root.addView(chooser, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT < 30) {
                // Older Androids keep the bars outside the window, so nothing is under them.
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                return insets.consumeSystemWindowInsets();
            }
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
            boolean typing = keyboard.bottom > bars.bottom;
            // A landscape navigation bar or cutout would hide the page's edges, and the keyboard its bottom,
            // so those shrink the page instead; the page pads itself for the bars above and below it.
            view.setPadding(bars.left, 0, bars.right, typing ? keyboard.bottom : 0);
            int bottom = typing ? 0 : bars.bottom;
            chooser.setBars(bars.top, bottom);
            float density = getResources().getDisplayMetrics().density;
            pageInsets = "{\"top\":" + (int) Math.ceil(bars.top / density) + ",\"bottom\":" + (int) Math.ceil(bottom / density) + "}";
            web.evaluateJavascript("(function(s,b){s.setProperty('--safe-top',b.top+'px');s.setProperty('--safe-bottom',b.bottom+'px')})"
                    + "(document.documentElement.style," + pageInsets + ")", null);
            // Pages from older servers read the same space from the WebView's own safe area.
            return new WindowInsets.Builder(insets)
                    .setInsets(WindowInsets.Type.systemBars(), Insets.of(0, bars.top, 0, bottom))
                    .setInsets(WindowInsets.Type.displayCutout(), Insets.NONE)
                    .setInsets(WindowInsets.Type.ime(), Insets.NONE)
                    .setDisplayCutout(null)
                    .build();
        });
    }

    /** The bars' icons are dark on a light screen and light on a dark one. */
    private void applySystemBars() {
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        boolean dark = web.getVisibility() == View.VISIBLE && pageDark != null ? pageDark : night;
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(dark ? 0 : light, light);
            }
        }
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
    }

    // --- choosing and connecting --------------------------------------------

    private void showChooser(String problem, boolean scanNow) {
        generation++;
        web.setVisibility(View.GONE);
        chooser.setVisibility(View.VISIBLE);
        chooser.showRecent(store.recent());
        chooser.showProblem(problem);
        applySystemBars();
        if (scanNow) scan();
    }

    private void scan() {
        final int mine = ++generation;
        chooser.showScanning();
        new Thread(() -> {
            List<Server> found = Discovery.scan(store.discoveryPorts(), 2500);
            runOnUiThread(() -> {
                if (mine == generation) chooser.showFound(found);
            });
        }, "discovery").start();
    }

    private void connect(Server server, boolean rediscover) {
        final int mine = ++generation;
        chooser.showRecent(store.recent());
        chooser.showConnecting(server);
        chooser.setVisibility(View.VISIBLE);
        web.setVisibility(View.GONE);
        new Thread(() -> {
            Server target = server;
            boolean reachable = reachable(target);
            if (!reachable && rediscover && !server.typed()) {
                for (Server found : Discovery.scan(store.discoveryPorts(), 2500)) {
                    if (found.id.equals(server.id)) {
                        target = found.at(found.host, found.port);
                        reachable = true;
                        break;
                    }
                }
            }
            final Server chosen = target;
            final boolean ok = reachable;
            runOnUiThread(() -> {
                if (mine != generation) return;
                if (ok) open(chosen);
                else showChooser(getString(R.string.unreachable, server.address()), true);
            });
        }, "connect").start();
    }

    private static boolean reachable(Server server) {
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(server.url() + "api/status").openConnection();
            connection.setConnectTimeout(2500);
            connection.setReadTimeout(2500);
            int code = connection.getResponseCode();
            connection.disconnect();
            return code == 200;
        } catch (java.io.IOException e) {
            return false;
        }
    }

    private void open(Server server) {
        current = server;
        store.remember(server);
        pageDark = null;
        hideKeyboard();
        chooser.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        applySystemBars();
        web.loadUrl(server.url());
    }

    private void hideKeyboard() {
        InputMethodManager keyboard = getSystemService(InputMethodManager.class);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(root.getWindowToken(), 0);
    }

    @Override
    public void onPick(Server server) {
        connect(server, !server.typed());
    }

    @Override
    public void onScan() {
        scan();
    }

    @Override
    public void onAddress(String text) {
        Server server = Server.fromAddress(text);
        if (server == null) {
            chooser.showAddressProblem(getString(R.string.invalid_address));
            return;
        }
        hideKeyboard();
        connect(server, false);
    }

    @Override
    public void onForget(Server server) {
        store.forget(server);
        chooser.showRecent(store.recent());
    }

    // --- navigation -----------------------------------------------------------

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (fullscreen.leave()) return;
        if (web.getVisibility() != View.VISIBLE) {
            if (current == null) {
                super.onBackPressed();
                return;
            }
            // Back from choosing returns to the page that was open.
            generation++;
            chooser.setVisibility(View.GONE);
            web.setVisibility(View.VISIBLE);
            applySystemBars();
            return;
        }
        // The page decides first (close a sheet, go up a folder); a leftover back leaves the app.
        web.evaluateJavascript("(window.wiiJukeboxBack && window.wiiJukeboxBack()) === true", result -> {
            if (!"true".equals(result)) moveTaskToBack(true);
        });
    }

    /** The page's fullscreen (the visualizer's): its view goes over everything and the bars hide. */
    private final class Fullscreen extends WebChromeClient {
        private View view;
        private CustomViewCallback callback;

        @Override
        public void onShowCustomView(View shown, CustomViewCallback done) {
            if (view != null) {
                done.onCustomViewHidden();
                return;
            }
            view = shown;
            callback = done;
            root.addView(shown, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            showBars(false);
        }

        @Override
        public void onHideCustomView() {
            if (view == null) return;
            root.removeView(view);
            view = null;
            callback = null;
            showBars(true);
        }

        boolean leave() {
            if (callback == null) return false;
            callback.onCustomViewHidden();
            onHideCustomView();
            return true;
        }

        private void showBars(boolean show) {
            if (Build.VERSION.SDK_INT < 30) return;
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller == null) return;
            if (show) {
                controller.show(WindowInsets.Type.systemBars());
            } else {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.systemBars());
            }
        }
    }

    /** Called from the web UI; runs on a WebView thread. */
    private final class Bridge {
        @JavascriptInterface
        public void switchServer() {
            runOnUiThread(() -> showChooser(null, true));
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }

        /** How much of the page the status and navigation bars cover, in CSS pixels. */
        @JavascriptInterface
        public String insets() {
            return pageInsets;
        }

        /** The page's background and whether it is dark, so the bars' icons stay readable on it. */
        @JavascriptInterface
        public void setTheme(String color, boolean dark) {
            runOnUiThread(() -> {
                try {
                    pageColor = Color.parseColor(color);
                } catch (IllegalArgumentException e) {
                    return;
                }
                pageDark = dark;
                root.setBackgroundColor(pageColor);
                web.setBackgroundColor(pageColor);
                applySystemBars();
            });
        }
    }
}

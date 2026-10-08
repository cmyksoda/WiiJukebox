// SPDX-License-Identifier: GPL-3.0-only
package org.wiijukebox.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/** Finds WiiJukebox servers on the LAN and shows the chosen one's controller page. */
public final class MainActivity extends Activity {
    private ServerStore store;
    private FrameLayout root;
    private WebView web;
    private LinearLayout chooser;
    private TextView status;
    private ListView list;
    private ArrayAdapter<Server> adapter;
    private final List<Server> servers = new ArrayList<>();
    private Server current;
    private int generation;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        store = new ServerStore(this);
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
        styleChooser();
    }

    @Override
    protected void onDestroy() {
        generation++;
        web.destroy();
        super.onDestroy();
    }

    // --- views -----------------------------------------------------------

    private int color(int resource) {
        return getResources().getColor(resource, getTheme());
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void buildViews() {
        root = new FrameLayout(this);
        root.setBackgroundColor(color(R.color.surface));

        web = new WebView(this);
        web.setVisibility(View.GONE);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= 33) settings.setAlgorithmicDarkeningAllowed(false);
        web.setBackgroundColor(color(R.color.surface));
        web.addJavascriptInterface(new Bridge(), "WiiJukeboxApp");
        web.setWebChromeClient(new WebChromeClient());
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

        chooser = new LinearLayout(this);
        chooser.setOrientation(LinearLayout.VERTICAL);
        chooser.setPadding(dp(20), dp(24), dp(20), dp(16));

        TextView brand = new TextView(this);
        brand.setText(R.string.app_name);
        brand.setTextSize(30);
        brand.setTypeface(Typeface.DEFAULT_BOLD);
        chooser.addView(brand);

        TextView title = new TextView(this);
        title.setText(R.string.choose_title);
        title.setTextSize(18);
        title.setPadding(0, dp(16), 0, dp(4));
        title.setTypeface(Typeface.DEFAULT_BOLD);
        chooser.addView(title);

        status = new TextView(this);
        status.setTextSize(14);
        status.setPadding(0, 0, 0, dp(10));
        chooser.addView(status);

        adapter = new ArrayAdapter<Server>(this, 0, servers) {
            @Override
            public View getView(int position, View convert, ViewGroup parent) {
                Server server = getItem(position);
                LinearLayout row = new LinearLayout(MainActivity.this);
                row.setOrientation(LinearLayout.VERTICAL);
                row.setPadding(dp(16), dp(12), dp(16), dp(12));
                GradientDrawable card = new GradientDrawable();
                card.setColor(color(R.color.card));
                card.setStroke(dp(1), color(R.color.edge));
                card.setCornerRadius(dp(14));
                row.setBackground(card);
                TextView name = new TextView(MainActivity.this);
                name.setText(server.name);
                name.setTextSize(17);
                name.setTypeface(Typeface.DEFAULT_BOLD);
                name.setTextColor(color(R.color.text));
                TextView detail = new TextView(MainActivity.this);
                String code = server.id.length() >= 8 ? "ID " + server.id.substring(0, 8) + " · " : "";
                detail.setText(code + server.address());
                detail.setTextSize(13);
                detail.setTextColor(color(R.color.dim));
                row.addView(name);
                row.addView(detail);
                FrameLayout cell = new FrameLayout(MainActivity.this);
                cell.setPadding(0, dp(5), 0, dp(5));
                cell.addView(row);
                return cell;
            }
        };
        list = new ListView(this);
        list.setAdapter(adapter);
        list.setDivider(null);
        list.setSelector(android.R.color.transparent);
        list.setOnItemClickListener((parent, view, position, id) -> connect(servers.get(position), false));
        chooser.addView(list, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        buttons.addView(button(R.string.scan_again, v -> scan()));
        buttons.addView(button(R.string.enter_address, v -> askAddress()));
        chooser.addView(buttons);

        root.addView(chooser, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        styleChooser();

        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int left = 0;
            int top = 0;
            int right = 0;
            int bottom = 0;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                left = bars.left;
                top = bars.top;
                right = bars.right;
                bottom = Math.max(bars.bottom, ime.bottom);
            } else {
                left = insets.getSystemWindowInsetLeft();
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(left, top, right, bottom);
            return insets;
        });
    }

    private Button button(int label, View.OnClickListener click) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setOnClickListener(click);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        params.setMargins(dp(4), 0, dp(4), 0);
        button.setLayoutParams(params);
        return button;
    }

    private void styleChooser() {
        root.setBackgroundColor(color(R.color.surface));
        for (int i = 0; i < chooser.getChildCount(); i++) {
            View child = chooser.getChildAt(i);
            if (child instanceof TextView) {
                TextView text = (TextView) child;
                text.setTextColor(text == status ? color(R.color.dim) : color(R.color.text));
            }
        }
        adapter.notifyDataSetChanged();
    }

    private void applySystemBars() {
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(night ? 0 : light, light);
            }
        }
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
    }

    // --- choosing and connecting --------------------------------------------

    private void showChooser(String message, boolean scanNow) {
        generation++;
        web.setVisibility(View.GONE);
        chooser.setVisibility(View.VISIBLE);
        status.setText(message != null ? message : getString(R.string.choose_hint));
        if (scanNow) scan();
    }

    private void scan() {
        final int mine = ++generation;
        servers.clear();
        adapter.notifyDataSetChanged();
        status.setText(R.string.searching);
        new Thread(() -> {
            List<Server> found = Discovery.scan(store.discoveryPorts(), 2500);
            runOnUiThread(() -> {
                if (mine != generation) return;
                servers.clear();
                servers.addAll(found);
                adapter.notifyDataSetChanged();
                status.setText(found.isEmpty() ? getString(R.string.none_found) : getString(R.string.choose_hint));
            });
        }, "discovery").start();
    }

    private void connect(Server server, boolean rediscover) {
        final int mine = ++generation;
        status.setText(R.string.searching);
        chooser.setVisibility(View.VISIBLE);
        web.setVisibility(View.GONE);
        new Thread(() -> {
            Server target = server;
            boolean reachable = reachable(target);
            if (!reachable && rediscover && !server.id.isEmpty()) {
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
        chooser.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(server.url());
    }

    private void askAddress() {
        EditText input = new EditText(this);
        input.setHint(R.string.address_hint);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        new AlertDialog.Builder(this)
                .setTitle(R.string.address_title)
                .setView(input)
                .setPositiveButton(R.string.connect, (dialog, which) -> {
                    Server server = Server.fromAddress(input.getText().toString());
                    if (server == null) status.setText(R.string.invalid_address);
                    else connect(server, false);
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    // --- navigation -----------------------------------------------------------

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web.getVisibility() != View.VISIBLE) {
            if (current != null) web.setVisibility(View.VISIBLE);
            if (current != null) chooser.setVisibility(View.GONE);
            else super.onBackPressed();
            return;
        }
        // The page decides first (close a sheet, go up a folder); a leftover back leaves the app.
        web.evaluateJavascript("(window.wiiJukeboxBack && window.wiiJukeboxBack()) === true", result -> {
            if (!"true".equals(result)) moveTaskToBack(true);
        });
    }

    /** Called from the web UI; runs on a WebView thread. */
    private final class Bridge {
        @JavascriptInterface
        public void switchServer() {
            runOnUiThread(() -> showChooser(null, true));
        }

        @JavascriptInterface
        public String version() {
            return "0.1.0";
        }
    }
}

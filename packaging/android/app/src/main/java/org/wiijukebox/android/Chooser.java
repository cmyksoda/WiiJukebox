// SPDX-License-Identifier: GPL-3.0-only
package org.wiijukebox.android;

import android.app.AlertDialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.text.InputType;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;

/** The first screen: servers found on this Wi-Fi, recent ones, and a field to type an address. */
final class Chooser extends ScrollView {
    interface Listener {
        void onPick(Server server);

        void onScan();

        void onAddress(String text);

        void onForget(Server server);
    }

    private final Ui ui;
    private final Listener listener;
    private final LinearLayout column;
    // Rebuilt on every render.
    private final LinearLayout lists;
    // Built once, so a render never takes the field away from someone typing in it.
    private final EditText address;
    private final TextView typeLabel;
    private final TextView connect;
    private final TextView addressError;
    private final TextView addressNote;
    private List<Server> found = new ArrayList<>();
    private List<Server> recent = new ArrayList<>();
    private boolean scanning;
    private Server connecting;
    private String problem;
    private String addressProblem;

    Chooser(Context context, Ui ui, Listener listener) {
        super(context);
        this.ui = ui;
        this.listener = listener;
        setFillViewport(true);
        column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(ui.dp(24), ui.dp(28), ui.dp(24), ui.dp(24));
        addView(column, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        lists = new LinearLayout(context);
        lists.setOrientation(LinearLayout.VERTICAL);
        column.addView(lists);

        address = new EditText(context);
        address.setHint(R.string.address_hint);
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setOnEditorActionListener((view, action, event) -> {
            listener.onAddress(address.getText().toString());
            return true;
        });
        connect = new TextView(context);
        connect.setText(R.string.connect);
        connect.setGravity(Gravity.CENTER);
        connect.setPadding(ui.dp(22), 0, ui.dp(22), 0);
        connect.setOnClickListener(v -> listener.onAddress(address.getText().toString()));
        LinearLayout row = new LinearLayout(context);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(address, new LinearLayout.LayoutParams(0, ui.dp(52), 1f));
        LinearLayout.LayoutParams go = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ui.dp(52));
        go.setMargins(ui.dp(10), 0, 0, 0);
        row.addView(connect, go);

        typeLabel = new TextView(context);
        addressError = new TextView(context);
        addressError.setPadding(0, ui.dp(8), 0, 0);
        addressError.setLineSpacing(0, 1.25f);
        addressNote = new TextView(context);
        addressNote.setText(R.string.address_note);
        addressNote.setPadding(0, ui.dp(10), 0, 0);
        addressNote.setLineSpacing(0, 1.25f);
        column.addView(sectionRow(typeLabel, R.string.type_address, null));
        column.addView(row);
        column.addView(addressError);
        column.addView(addressNote);
        render();
    }

    // --- state -----------------------------------------------------------------

    void showScanning() {
        scanning = true;
        found = new ArrayList<>();
        render();
    }

    void showFound(List<Server> servers) {
        scanning = false;
        found = servers;
        render();
    }

    void showRecent(List<Server> servers) {
        recent = servers;
        render();
    }

    void showConnecting(Server server) {
        connecting = server;
        problem = null;
        addressProblem = null;
        render();
    }

    /** Back to choosing, with what went wrong if anything did. */
    void showProblem(String message) {
        connecting = null;
        problem = message;
        render();
    }

    void showAddressProblem(String message) {
        addressProblem = message;
        render();
        // The field and what is wrong with it sit at the bottom, where the keyboard would hide them.
        post(() -> smoothScrollTo(0, column.getBottom()));
    }

    /** The page lies under the system bars; this keeps the screen's content out from under them. */
    void setBars(int top, int bottom) {
        setPadding(0, top, 0, bottom);
    }

    // --- drawing -----------------------------------------------------------------

    /** Rebuilt from its state on every change and theme switch; the lists are a handful of rows. */
    void render() {
        setBackground(ui.stripes());
        lists.removeAllViews();
        header();
        if (connecting != null) lists.addView(notice(getContext().getString(R.string.connecting, connecting.address()), false));
        else if (problem != null) lists.addView(notice(problem, true));

        section(R.string.on_this_wifi, scanButton());
        if (!found.isEmpty()) {
            for (Server server : found) lists.addView(serverRow(server, server.address(), false));
        } else if (scanning) {
            lists.addView(searching());
        } else {
            lists.addView(nothingFound());
        }

        List<Server> others = new ArrayList<>();
        for (Server server : recent) {
            boolean listed = false;
            for (Server shown : found) listed |= shown.sameAs(server);
            if (!listed) others.add(server);
        }
        if (!others.isEmpty()) {
            section(R.string.recent, null);
            for (Server server : others) {
                String detail = server.typed() ? getContext().getString(R.string.typed) : server.address();
                lists.addView(serverRow(server, detail, true));
            }
        }

        styleTyping();
    }

    /** Only the colors and the error change here; the views themselves stay. */
    private void styleTyping() {
        ui.font(typeLabel, 13, 800, R.color.dim);
        ui.font(address, 17, 600, R.color.text);
        address.setHintTextColor(ui.color(R.color.dim));
        address.setPadding(ui.dp(16), 0, ui.dp(16), 0);
        StateListDrawable field = new StateListDrawable();
        GradientDrawable focused = ui.shape(R.color.card, 0, 14);
        focused.setStroke(ui.dp(2), ui.color(R.color.accent));
        field.addState(new int[] {android.R.attr.state_focused}, focused);
        field.addState(new int[0], ui.shape(R.color.card, R.color.edge, 14));
        address.setBackground(field);
        ui.font(connect, 16, 800, R.color.on_accent);
        connect.setBackground(ui.pressable(ui.shape(R.color.button, 0, 26), 26));
        ui.font(addressError, 14, 600, R.color.danger);
        addressError.setText(addressProblem);
        addressError.setVisibility(addressProblem == null ? GONE : VISIBLE);
        ui.font(addressNote, 14, 500, R.color.dim);
    }

    private void header() {
        ImageView icon = new ImageView(getContext());
        icon.setImageResource(R.mipmap.ic_launcher);
        lists.addView(icon, new LinearLayout.LayoutParams(ui.dp(64), ui.dp(64)));

        SpannableString name = new SpannableString(getContext().getString(R.string.app_name));
        name.setSpan(new ForegroundColorSpan(ui.color(R.color.brand)), 0, 3, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        TextView wordmark = ui.text(name, 32, 800, R.color.text);
        wordmark.setPadding(0, ui.dp(18), 0, ui.dp(6));
        wordmark.setLetterSpacing(-0.02f);
        lists.addView(wordmark);
        lists.addView(ui.text(getContext().getString(R.string.choose_hint), 16, 500, R.color.dim));
    }

    private void section(int title, View trailing) {
        lists.addView(sectionRow(new TextView(getContext()), title, trailing));
    }

    private LinearLayout sectionRow(TextView label, int title, View trailing) {
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(ui.dp(36));
        ui.font(label, 13, 800, R.color.dim);
        label.setText(getContext().getString(title).toUpperCase());
        label.setLetterSpacing(0.08f);
        row.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        if (trailing != null) row.addView(trailing);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, ui.dp(30), 0, ui.dp(10));
        row.setLayoutParams(params);
        return row;
    }

    private View scanButton() {
        LinearLayout button = new LinearLayout(getContext());
        button.setGravity(Gravity.CENTER_VERTICAL);
        button.setPadding(ui.dp(14), 0, ui.dp(14), 0);
        button.setMinimumHeight(ui.dp(36));
        button.setBackground(ui.pressable(ui.shape(R.color.card, R.color.edge, 18), 18));
        if (scanning) {
            ProgressBar spinner = new ProgressBar(getContext());
            spinner.setIndeterminateTintList(ColorStateList.valueOf(ui.color(R.color.accent)));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ui.dp(16), ui.dp(16));
            params.setMargins(0, 0, ui.dp(8), 0);
            button.addView(spinner, params);
        }
        button.addView(ui.text(getContext().getString(scanning ? R.string.scanning : R.string.scan_again), 14, 700, R.color.accent));
        button.setEnabled(!scanning);
        button.setOnClickListener(v -> listener.onScan());
        return button;
    }

    private View serverRow(Server server, String detail, boolean forgettable) {
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(ui.dp(14), ui.dp(12), ui.dp(16), ui.dp(12));
        row.setMinimumHeight(ui.dp(68));
        row.setBackground(ui.pressable(ui.shape(R.color.card, R.color.edge, 16), 16));

        // The jukebox from the launcher icon, in the page's blue on a pale disc.
        FrameLayout badge = new FrameLayout(getContext());
        badge.setBackground(disc());
        ImageView mark = new ImageView(getContext());
        mark.setImageResource(R.drawable.ic_launcher_foreground);
        mark.setImageTintList(ColorStateList.valueOf(ui.color(R.color.brand)));
        badge.addView(mark, new FrameLayout.LayoutParams(ui.dp(60), ui.dp(60), Gravity.CENTER));
        LinearLayout.LayoutParams badgeParams = new LinearLayout.LayoutParams(ui.dp(44), ui.dp(44));
        badgeParams.setMargins(0, 0, ui.dp(14), 0);
        badge.setClipToOutline(true);
        row.addView(badge, badgeParams);

        LinearLayout text = new LinearLayout(getContext());
        text.setOrientation(LinearLayout.VERTICAL);
        TextView name = ui.text(server.typed() ? server.address() : server.name, 17, 800, R.color.text);
        name.setSingleLine(true);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        TextView sub = ui.text(detail, 14, 600, R.color.dim);
        sub.setSingleLine(true);
        sub.setPadding(0, ui.dp(3), 0, 0);
        text.addView(name);
        text.addView(sub);
        row.addView(text, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if (connecting != null && connecting.sameAs(server)) {
            ProgressBar spinner = new ProgressBar(getContext());
            spinner.setIndeterminateTintList(ColorStateList.valueOf(ui.color(R.color.accent)));
            row.addView(spinner, new LinearLayout.LayoutParams(ui.dp(22), ui.dp(22)));
        } else {
            row.addView(ui.text("›", 28, 600, R.color.dim));
        }

        row.setOnClickListener(v -> listener.onPick(server));
        if (forgettable) row.setOnLongClickListener(v -> {
            confirmForget(server);
            return true;
        });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, 0, 0, ui.dp(10));
        row.setLayoutParams(params);
        return row;
    }

    private GradientDrawable disc() {
        GradientDrawable disc = new GradientDrawable();
        disc.setShape(GradientDrawable.OVAL);
        disc.setColor(ui.color(R.color.accent_soft));
        return disc;
    }

    private View searching() {
        LinearLayout box = placeholder();
        ProgressBar spinner = new ProgressBar(getContext());
        spinner.setIndeterminateTintList(ColorStateList.valueOf(ui.color(R.color.accent)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ui.dp(22), ui.dp(22));
        params.setMargins(0, 0, ui.dp(12), 0);
        box.setOrientation(LinearLayout.HORIZONTAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.addView(spinner, params);
        box.addView(ui.text(getContext().getString(R.string.searching), 15, 600, R.color.dim));
        return box;
    }

    private View nothingFound() {
        LinearLayout box = placeholder();
        box.addView(ui.text(getContext().getString(R.string.none_found_title), 16, 800, R.color.text));
        TextView body = ui.text(getContext().getString(R.string.none_found), 14, 500, R.color.dim);
        body.setPadding(0, ui.dp(6), 0, 0);
        box.addView(body);
        return box;
    }

    /** An empty list's stand-in: a dashed outline where the cards would be. */
    private LinearLayout placeholder() {
        LinearLayout box = new LinearLayout(getContext());
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(ui.dp(18), ui.dp(16), ui.dp(18), ui.dp(16));
        box.setMinimumHeight(ui.dp(68));
        GradientDrawable outline = new GradientDrawable();
        outline.setCornerRadius(ui.dp(16));
        outline.setStroke(ui.dp(1.5f), ui.color(R.color.edge), ui.dp(6), ui.dp(5));
        box.setBackground(outline);
        return box;
    }

    private View notice(String message, boolean error) {
        LinearLayout box = new LinearLayout(getContext());
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(ui.dp(16), ui.dp(14), ui.dp(16), ui.dp(14));
        box.setBackground(ui.shape(error ? R.color.danger_soft : R.color.accent_soft, 0, 14));
        if (!error) {
            ProgressBar spinner = new ProgressBar(getContext());
            spinner.setIndeterminateTintList(ColorStateList.valueOf(ui.color(R.color.accent)));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ui.dp(20), ui.dp(20));
            params.setMargins(0, 0, ui.dp(12), 0);
            box.addView(spinner, params);
        }
        box.addView(ui.text(message, 15, 700, error ? R.color.danger : R.color.text),
                new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, ui.dp(24), 0, 0);
        box.setLayoutParams(params);
        return box;
    }

    private void confirmForget(Server server) {
        String name = server.typed() ? server.address() : server.name;
        new AlertDialog.Builder(getContext())
                .setTitle(getContext().getString(R.string.forget_title, name))
                .setMessage(R.string.forget_body)
                .setPositiveButton(R.string.forget, (dialog, which) -> listener.onForget(server))
                .setNegativeButton(R.string.cancel, null)
                .show();
    }
}

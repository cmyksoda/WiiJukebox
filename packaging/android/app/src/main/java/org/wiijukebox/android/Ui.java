// SPDX-License-Identifier: GPL-3.0-only
package org.wiijukebox.android;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.widget.TextView;

/** The controller page's look for native screens: its Nunito, its colors, pills and pinstripes. */
final class Ui {
    private final Context context;
    private final Typeface nunito;

    Ui(Context context) {
        this.context = context;
        nunito = Typeface.createFromAsset(context.getAssets(), "fonts/nunito.ttf");
    }

    int dp(float value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    int color(int resource) {
        return context.getResources().getColor(resource, context.getTheme());
    }

    /** Nunito is one variable font whose default is its lightest weight, so every view names its own. */
    <T extends TextView> T font(T view, float sp, int weight, int color) {
        view.setTextSize(sp);
        view.setTypeface(nunito);
        // A new typeface drops the weight, and setting the same weight again is skipped, so clear it first.
        view.setFontVariationSettings(null);
        view.setFontVariationSettings("'wght' " + weight);
        view.setTextColor(color(color));
        view.setIncludeFontPadding(false);
        return view;
    }

    TextView text(CharSequence value, float sp, int weight, int color) {
        TextView view = font(new TextView(context), sp, weight, color);
        view.setText(value);
        view.setLineSpacing(0, 1.25f);
        return view;
    }

    GradientDrawable shape(int fill, int stroke, float radius) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color(fill));
        if (stroke != 0) shape.setStroke(dp(1), color(stroke));
        shape.setCornerRadius(dp(radius));
        return shape;
    }

    /** A rounded shape that ripples when pressed. */
    Drawable pressable(Drawable content, float radius) {
        GradientDrawable mask = new GradientDrawable();
        mask.setColor(0xffffffff);
        mask.setCornerRadius(dp(radius));
        return new RippleDrawable(ColorStateList.valueOf(color(R.color.ripple)), content, mask);
    }

    /** The page's background: a 1dp pinstripe every 7dp, as in the Wii Menu. */
    Drawable stripes() {
        return new Stripes(color(R.color.surface), color(R.color.stripe), dp(7), Math.max(1, dp(1)));
    }

    private static final class Stripes extends Drawable {
        private final int background;
        private final int period;
        private final int line;
        private final Paint paint = new Paint();

        Stripes(int background, int stripe, int period, int line) {
            this.background = background;
            this.period = period;
            this.line = line;
            paint.setColor(stripe);
        }

        @Override
        public void draw(Canvas canvas) {
            canvas.drawColor(background);
            int width = getBounds().width();
            for (int y = period - line; y < getBounds().height(); y += period) canvas.drawRect(0, y, width, y + line, paint);
        }

        @Override
        public void setAlpha(int alpha) {}

        @Override
        public void setColorFilter(ColorFilter filter) {}

        @Override
        public int getOpacity() {
            return PixelFormat.OPAQUE;
        }
    }
}

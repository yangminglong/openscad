include <BOSL2/std.scad>

/* [Size（尺寸组）] */
// 瓶体高度
height_mm = 180;                  // [80:5:350]
// 底部直径
base_diameter_mm = 70;            // [30:1:180]
// 腰部膨出量
belly_gain_mm = 22;               // [0:1:80]
// 颈部直径
neck_diameter_mm = 36;            // [16:1:120]
// 瓶口直径
mouth_diameter_mm = 58;           // [20:1:160]

/* [Neck & Opening（颈部与瓶口）] */
// 颈部位置（占总高度百分比）
neck_pos_percent = 70;            // [45:1:90]

/* [Walls & Base（壁与底座）] */
// 壁厚
wall_thickness_mm = 2.4;          // [1.2:0.2:8]
// 底部厚度
base_thickness_mm = 8;            // [2:0.5:25]
// 内壁形状（true=跟随外壁扭曲，false=原始行为：平滑无扭曲）
inner_shape = true;               // [0:1]

/* [Mouth Roundover（瓶口圆角）] */
// 启用瓶口圆角
mouth_roundover = true;           // [0:1]
// 圆角半径（百分比，自动计算，100%时瓶口为半圆）
mouth_roundover_pct = 50;         // [1:1:100]

/* [Surface & Twist（表面纹理与扭转）] */
// 螺旋棱线深度
ridge_depth = 4;                  // [0:0.2:15]
// 棱线形状（<1宽胖，1标准，>1尖细）
ridge_profile = 1;                // [0.35:0.05:3]
// 扭转类型（0=经典螺旋，1=波浪正弦）
twist_style = 0;                  // [0:1]
// 波浪方向变化次数（仅 Wavy 模式）
wave_cycles = 3;                  // [1:1:10]
// 总扭转角度/波浪振幅
twist_amount = 240;               // [0:5:720]
// 棱线数量
num_ridges = 18;                  // [4:1:48]
// 棱线渐隐距离
ridge_fade_distance = 20;         // [0:1:80]

/* [Quality（精度）] */
// 变换步数
steps = 60;                       // [24:4:200]
// 截面顶点数
shape_pts = 144;                  // [64:8:288]

/* [Appearance] */
color_name = "#4a4f48";           // 颜色

// ──── Derived ─────────────────────────────────────────────────
_base_r  = base_diameter_mm / 2;
_neck_r  = neck_diameter_mm / 2;
_mouth_r = mouth_diameter_mm / 2;
_belly_r = _base_r + belly_gain_mm;
_has_ridges = ridge_depth > 0 && num_ridges >= 4;
_rel_depth = _has_ridges ? ridge_depth / max(1, _belly_r) : 0;
_mouth_rr  = mouth_roundover ? wall_thickness_mm / 2 * mouth_roundover_pct / 100 : 0;

// ──── Helpers ─────────────────────────────────────────────────
function _clamp(v, lo, hi) = min(max(v, lo), hi);
function _mix(a, b, t)    = a + (b - a) * t;

function _smoothstep(edge0, edge1, x) =
    let(t = _clamp((x - edge0) / max(0.0001, edge1 - edge0), 0, 1))
    t * t * (3 - 2 * t);

// ──── Vase profile: height → radius ───────────────────────────
function vase_radius_at(z) =
    let(
        hf     = z / height_mm,
        neck_f = _clamp(neck_pos_percent / 100, 0.35, 0.92),
        belly_f = _clamp(neck_f * 0.55, 0.22, 0.62),

        bb = _smoothstep(0, belly_f, hf),
        bn = _smoothstep(belly_f, neck_f, hf),
        nm = _smoothstep(neck_f, 1, hf),

        lo = _mix(_base_r, _belly_r, bb),
        mi = _mix(_belly_r, _neck_r, bn),
        hi = _mix(_neck_r, _mouth_r, nm),

        below = _mix(lo, mi, _smoothstep(max(0.05, belly_f * 0.65), neck_f, hf)),
        r     = hf <= neck_f ? below : hi,
        foot  = _mix(_base_r, r, _smoothstep(0, 0.08, hf))
    )
    max(4, foot);

// ──── Ridge & twist ───────────────────────────────────────────
function ridge_fade_at(z) =
    ridge_fade_distance <= 0 ? 1 :
    let(
        bot = _smoothstep(0, max(0.001, ridge_fade_distance), z),
        top = 1 - _smoothstep(height_mm - max(0.001, ridge_fade_distance), height_mm, z)
    )
    min(bot, top);

function twist_angle_at(z) =
    twist_style == 0
        ? twist_amount * z / height_mm
        : twist_amount / 2 * sin(360 * wave_cycles * z / height_mm);

// ──── Three-section outer body ────────────────────────────────
// Perf: only the fade zones need per-profile shapes (fade varies).
// The middle section (fade=1, ~80% of profiles) uses one sweep() call.
_top_ext   = 2;
_total_h   = height_mm + _top_ext;

// Section boundaries (clamped)
_fade_lo = _has_ridges ? _clamp(ridge_fade_distance, 0.01, _total_h - 0.01) : 0;
_fade_hi = _has_ridges ? _clamp(height_mm - ridge_fade_distance, _fade_lo, _total_h) : _total_h;
_has_mid = _fade_hi > _fade_lo + 0.01;   // middle section exists?

// ── Shared: normalized full-ridge shape (r≈1, for sweep middle) ─
function _mk_shape(fade) =
    !_has_ridges
        ? circle(r = 1, $fn = shape_pts)
    : let(
        da    = 360 / shape_pts,
        depth = _rel_depth * fade,
        prof  = max(0.05, ridge_profile)
    ) [
        for (i = [0:shape_pts-1])
            let(a = i * da,
                phase = num_ridges * a,
                bump  = depth * pow((cos(phase) + 1) / 2, prof),
                r     = 1 + bump)
            [r * cos(a), r * sin(a)]
    ];

_full_shape = _mk_shape(1);   // fade=1 → full ridges
_rev_shape  = reverse(_full_shape);  // opposite winding for sweep preview

// ── Bottom fade section (skin): per-profile, fade 0→1 ─────────
_bot_N  = _has_ridges ? max(2, round(steps * _fade_lo / _total_h)) : 0;
_bot_profiles = _bot_N < 2 ? [] : [for (i = [0:_bot_N-1])
    let(
        z  = i * _fade_lo / (_bot_N - 1),
        cz = min(z, height_mm),
        R  = vase_radius_at(cz),
        tw = _has_ridges ? twist_angle_at(cz) : 0,
        fd = ridge_fade_at(cz),
        sh = _mk_shape(fd),
        sc = [for (p = sh) [R * p[0], R * p[1]]]   // scale to vase radius
    )
    zrot(tw, p = path3d(sc, z))
];

// ── Middle section (sweep): one shape, transforms only ─────────
_mid_N  = _has_mid ? max(2, round(steps * (_fade_hi - _fade_lo) / _total_h)) : 0;
_mid_T  = _mid_N < 2 ? [] : [for (i = [0:_mid_N-1])
    let(
        z  = _fade_lo + i * (_fade_hi - _fade_lo) / max(1, _mid_N - 1),
        cz = min(z, height_mm),
        R  = vase_radius_at(cz),
        tw = _has_ridges ? twist_angle_at(cz) : 0
    )
    up(z) * zrot(tw) * scale([R, R, 1])
];

// ── Top fade section (skin): per-profile, fade 1→0 ────────────
_top_N = _has_ridges ? max(2, round(steps * (_total_h - _fade_hi) / _total_h)) : 0;
_top_profiles = _top_N < 2 ? [] : [for (i = [0:_top_N-1])
    let(
        z  = _fade_hi + i * (_total_h - _fade_hi) / max(1, _top_N - 1),
        cz = min(z, height_mm),
        R  = vase_radius_at(cz),
        tw = _has_ridges ? twist_angle_at(cz) : 0,
        fd = ridge_fade_at(cz),
        sh = _mk_shape(fd),
        sc = [for (p = sh) [R * p[0], R * p[1]]]
    )
    zrot(tw, p = path3d(sc, z))
];

// smoothness for skin sections
_slices = max(0, round(30 / max(1, steps)));

// ── Vase outer module ────────────────────────────────────────
module vase_outer() {
    // Unified 3-section: caps=true on each → all closed → union watertight.
    // Preview normals handled per-section (render() on sweep).
    if (len(_bot_profiles) >= 2)
        render(convexity = 4)
            skin(_bot_profiles, slices = _slices, caps = true, method = "direct");
    if (len(_mid_T) >= 2)
        render(convexity = 4)
            sweep(_rev_shape, _mid_T, caps = true);
    if (len(_top_profiles) >= 2)
        render(convexity = 4)
            skin(_top_profiles, slices = _slices, caps = true, method = "direct");
    // Fallback: single skin if no sections (e.g. no ridges)
    if (len(_bot_profiles) < 2 && len(_mid_T) < 2 && len(_top_profiles) < 2)
        render(convexity = 4)
            skin([for (i = [0:steps])
                let(z = i * _total_h / steps, cz = min(z, height_mm),
                    R = vase_radius_at(cz),
                    tw = _has_ridges ? twist_angle_at(cz) : 0,
                    fd = ridge_fade_at(cz),
                    sh = _mk_shape(fd),
                    sc = [for (p = sh) [R * p[0], R * p[1]]])
                zrot(tw, p = path3d(sc, z))
            ], slices = _slices, caps = true, method = "direct");
}

// ──── Inner cavity ────────────────────────────────────────────
// inner_shape=true: single skin() with per-profile ridges+twist+fade
// inner_shape=false: simple sweep, smooth, follows profile
_inner_has_ridges = (inner_shape && _has_ridges);
_inner_N = max(4, round(steps * 0.7));

_inner_profiles = !_inner_has_ridges ? [] : [for (i = [0:_inner_N-1])
    let(
        z  = wall_thickness_mm + i * (_total_h - wall_thickness_mm)
             / max(1, _inner_N - 1),
        cz = min(z, height_mm),
        R  = max(1.0, vase_radius_at(cz) - wall_thickness_mm),
        tw = twist_angle_at(cz),
        fd = ridge_fade_at(cz),
        sh = _mk_shape(fd),
        sc = [for (p = sh) [R * p[0], R * p[1]]]
    )
    zrot(tw, p = path3d(sc, z))
];

module vase_inner() {
    if (_inner_has_ridges) {
        render(convexity = 4)
            skin(_inner_profiles, slices = _slices, caps = true,
                 method = "direct");
    } else {
        render(convexity = 4)
            sweep(circle(r = 1, $fn = max(48, round(shape_pts/2))),
                [for (i = [0:max(4,round(steps/2))-1])
                    let(z = wall_thickness_mm + i * (_total_h - wall_thickness_mm)
                        / max(1, max(4,round(steps/2)) - 1),
                        cz = min(z, height_mm),
                        R  = max(1.0, vase_radius_at(cz) - wall_thickness_mm))
                    up(z) * scale([R, R, 1])],
                caps = true);
    }
}

// ──── Vase ────────────────────────────────────────────────────
module vase_closed() {
    difference() {
        vase_outer();
        vase_inner();
    }
}

module vase() {
    difference() {
        vase_closed();
        // cut off top to open mouth
        up(height_mm) zcyl(r = _mouth_r + 50, h = _top_ext + 0.1, anchor = BOTTOM);
        // mouth roundover masks
        if (_mouth_rr > 0) {
            up(height_mm) {
                // outer edge: round like a cylinder end
                rounding_cylinder_mask(r = _mouth_r, rounding = _mouth_rr, $fn=64);
                // inner edge: round like a hole edge
                rounding_hole_mask(
                    r = _mouth_r - wall_thickness_mm,
                    rounding = _mouth_rr, excess = 0.1, $fn=64
                );
            }
        }
    }
}

color(color_name) vase();

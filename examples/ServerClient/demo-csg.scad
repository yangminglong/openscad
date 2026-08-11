// Demo: Complex CSG tree
// This demonstrates server-side computation of boolean-heavy geometry
$fn = 80;

difference() {
  union() {
    sphere(r = 20);
    for (a = [0:90:270]) {
      rotate([0, 0, a])
        translate([18, 0, 0])
          cylinder(h = 8, r = 6, center = true);
    }
  }
  sphere(r = 15);
  rotate([90, 0, 0]) cylinder(h = 50, r = 4, center = true);
  rotate([0, 90, 0]) cylinder(h = 50, r = 4, center = true);
}

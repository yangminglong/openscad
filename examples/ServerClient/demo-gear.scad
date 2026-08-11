// Demo: Parametric gear
$fn = 60;

module gear(teeth = 12, radius = 20, height = 6, hole = 5) {
  difference() {
    union() {
      cylinder(r = radius, h = height, center = true);
      for (i = [0:teeth-1]) {
        rotate([0, 0, i * 360 / teeth])
          translate([radius * 0.85, 0, 0])
            cube([radius * 0.3, radius * 0.2, height], center = true);
      }
    }
    cylinder(r = hole, h = height + 1, center = true);
  }
}

gear(teeth = 12, radius = 20, height = 6, hole = 4);

// Demo: Rounded box with mounting holes
// The browser never executes this script — it is sent to the server for rendering.
$fn = 60;

difference() {
  cube([30, 20, 15], center = true);
  translate([0, 0, 2])
    cube([26, 16, 15], center = true);
  translate([10, 6, 0]) cylinder(h = 20, d = 3.5, center = true);
  translate([-10, 6, 0]) cylinder(h = 20, d = 3.5, center = true);
  translate([10, -6, 0]) cylinder(h = 20, d = 3.5, center = true);
  translate([-10, -6, 0]) cylinder(h = 20, d = 3.5, center = true);
}

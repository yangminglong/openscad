## 启动服务

```bash
cd /home/hanson/OpenSCAD/openscad/examples/web && python3 -m http.server 8080
```

启动后浏览器访问 `http://localhost:8080`。

## 查询字体名
```bash
fc-scan /home/hanson/OpenSCAD/openscad/examples/web/fonts/simkai.ttf | grep postscriptname
```
输出         postscriptname: "KaiTi"(s)
from PIL import Image

base = r"C:\Users\huizh\Apps\HZ code\tmp\pdfs\stat_section"
Image.open(base + r"\hi-40.png").crop((250, 1800, 2450, 2700)).save(base + r"\crop-40.png")
Image.open(base + r"\hi-41.png").crop((0, 0, 2550, 700)).save(base + r"\crop-41a.png")
Image.open(base + r"\hi-41.png").crop((100, 2050, 2500, 3200)).save(base + r"\crop-41b.png")

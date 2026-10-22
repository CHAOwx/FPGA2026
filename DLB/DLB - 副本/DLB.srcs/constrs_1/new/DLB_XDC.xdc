# ============================================
# Clock
# ============================================
set_property PACKAGE_PIN Y18 [get_ports clk]
set_property IOSTANDARD LVCMOS33 [get_ports clk]
create_clock -period 20.000 -name sys_clk [get_ports clk]

# ============================================
# Reset
# ============================================
set_property PACKAGE_PIN B21 [get_ports rst_n]
set_property IOSTANDARD LVCMOS33 [get_ports rst_n]

# ============================================
# key_in[3:0]
# ============================================
set_property PACKAGE_PIN F15 [get_ports {key_in[0]}]
set_property PACKAGE_PIN A20 [get_ports {key_in[1]}]
set_property PACKAGE_PIN B20 [get_ports {key_in[2]}]
set_property PACKAGE_PIN A21 [get_ports {key_in[3]}]

set_property IOSTANDARD LVCMOS33 [get_ports {key_in[0]}]
set_property IOSTANDARD LVCMOS33 [get_ports {key_in[1]}]
set_property IOSTANDARD LVCMOS33 [get_ports {key_in[2]}]
set_property IOSTANDARD LVCMOS33 [get_ports {key_in[3]}]

# ============================================
# 7段数码管
# ============================================
set_property PACKAGE_PIN M18 [get_ports ds]
set_property PACKAGE_PIN F4 [get_ports sh_cp]
set_property PACKAGE_PIN C2 [get_ports st_cp]

set_property IOSTANDARD LVCMOS33 [get_ports ds]
set_property IOSTANDARD LVCMOS33 [get_ports sh_cp]
set_property IOSTANDARD LVCMOS33 [get_ports st_cp]

# ============================================
# uart_tx + uart_rx
# ============================================
set_property PACKAGE_PIN M15 [get_ports uart_tx]
set_property IOSTANDARD LVCMOS33 [get_ports uart_tx]

set_property PACKAGE_PIN J21 [get_ports uart_rx]
set_property IOSTANDARD LVCMOS33 [get_ports uart_rx]

# ============================================
# 编码器
# ============================================
set_property PACKAGE_PIN A13 [get_ports encoder_a]
set_property PACKAGE_PIN A15 [get_ports encoder_b]

set_property IOSTANDARD LVCMOS33 [get_ports encoder_a]
set_property IOSTANDARD LVCMOS33 [get_ports encoder_b]

# ============================================
# TB6612驱动电机
# ============================================
set_property PACKAGE_PIN A18 [get_ports  tb_in1]
set_property PACKAGE_PIN F13 [get_ports  tb_in2]
set_property PACKAGE_PIN E13 [get_ports  tb_pwm]

set_property IOSTANDARD LVCMOS33 [get_ports  tb_in1]
set_property IOSTANDARD LVCMOS33 [get_ports  tb_in2]
set_property IOSTANDARD LVCMOS33 [get_ports  tb_pwm]

# ============================================
# ADC采样模块
# ============================================

set_property IOSTANDARD LVCMOS33 [get_ports ADC_SCLK]
set_property IOSTANDARD LVCMOS33 [get_ports ADC_DIN]
set_property IOSTANDARD LVCMOS33 [get_ports ADC_DOUT]
set_property IOSTANDARD LVCMOS33 [get_ports ADC_CS_N]

set_property PACKAGE_PIN N5 [get_ports ADC_SCLK]
set_property PACKAGE_PIN M5 [get_ports ADC_DIN]
set_property PACKAGE_PIN P6 [get_ports ADC_DOUT]
set_property PACKAGE_PIN M6 [get_ports ADC_CS_N]

# ============================================
# SPI Flash Boot
# ============================================
set_property BITSTREAM.CONFIG.CONFIGRATE 33 [current_design]
set_property CONFIG_MODE SPIx4 [current_design]
set_property BITSTREAM.CONFIG.SPI_BUSWIDTH 4 [current_design]

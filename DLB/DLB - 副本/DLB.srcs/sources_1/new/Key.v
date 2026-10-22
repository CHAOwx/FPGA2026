// 项目: 按键消抖模块
// 功能:
// 1. 对异步机械按键进行两级同步
// 2. 每 5ms 采样一次
// 3. 连续 5 次采样相同后，认为按键状态稳定
// 4. 输出稳定状态 key_state
// 5. 输出按下事件 key_press
// 6. 输出松开事件 key_release
// 7. 输出任意状态变化事件 key_change
//
// 默认系统时钟: 50MHz
// 默认按键: 松开=1，按下=0
//
// 注意:
// key_press / key_release / key_change 均只保持 1 个 clk 周期

`timescale 1ns / 1ps

module key
#(
    parameter KEY_UNPRESSED = 1'b1    // 默认松开电平
)
(
    input  wire clk,
    input  wire rst_n,
    input  wire key_in,

    output reg  key_state,      // 当前稳定按键状态
    output reg  key_press,      // 按下事件，持续1个clk
    output reg  key_release,    // 松开事件，持续1个clk
    output reg  key_change      // 状态发生变化，持续1个clk
);


//==========================================================
// 1. 异步按键信号两级同步
//==========================================================
//
// key_in 是 FPGA 外部输入信号，与 clk 不同步。
// 使用两个触发器进行同步，降低亚稳态传播风险。
//

reg key_sync1;
reg key_sync2;

always @(posedge clk or negedge rst_n) begin
    if(!rst_n) begin
        key_sync1 <= KEY_UNPRESSED;
        key_sync2 <= KEY_UNPRESSED;
    end
    else begin
        key_sync1 <= key_in;
        key_sync2 <= key_sync1;
    end
end


//==========================================================
// 2. 产生 5ms 采样使能信号
//==========================================================
//
// 系统时钟:
// 50MHz
//
// 1个时钟周期:
// 20ns
//
// 5ms需要:
// 50,000,000 × 0.005 = 250,000 个周期
//
// 从0计数到249999，共250000个周期
//

reg [17:0] key_cnt;
reg        key_sample_en;

always @(posedge clk or negedge rst_n) begin
    if(!rst_n) begin
        key_cnt       <= 18'd0;
        key_sample_en <= 1'b0;
    end
    else begin

        // 默认没有到采样时间
        key_sample_en <= 1'b0;

        if(key_cnt >= 18'd249_999) begin
            key_cnt       <= 18'd0;
            key_sample_en <= 1'b1;
        end
        else begin
            key_cnt <= key_cnt + 1'b1;
        end

    end
end


//==========================================================
// 3. 滑动窗口
//==========================================================
//
// 每5ms采样一次，共保存最近5次采样结果。
//
// 例如按键低电平有效:
//
// 初始:
// 11111
//
// 按下之后:
// 11110
// 11100
// 11000
// 10000
// 00000
//
// 连续5次为0:
//      确认按下
//
// 连续5次为1:
//      确认松开
//

reg [4:0] key_status_reg;

always @(posedge clk or negedge rst_n) begin
    if(!rst_n)
        key_status_reg <= {5{KEY_UNPRESSED}};

    else if(key_sample_en)
        key_status_reg <= {key_status_reg[3:0], key_sync2};
end


//==========================================================
// 4. 按键稳定状态以及事件检测
//==========================================================
//
// key_state:
//      持续表示当前稳定状态
//
// key_press:
//      按键刚刚被确认按下
//      仅持续1个clk
//
// key_release:
//      按键刚刚被确认松开
//      仅持续1个clk
//
// key_change:
//      无论按下还是松开，只要稳定状态变化
//      就产生1个clk脉冲
//

always @(posedge clk or negedge rst_n) begin
    if(!rst_n) begin

        key_state   <= KEY_UNPRESSED;

        key_press   <= 1'b0;
        key_release <= 1'b0;
        key_change  <= 1'b0;

    end
    else begin

        //==================================================
        // 事件信号默认拉低
        //
        // 因此每次产生事件时只会持续一个clk
        //==================================================

        key_press   <= 1'b0;
        key_release <= 1'b0;
        key_change  <= 1'b0;


        //==================================================
        // 检测稳定按下
        //==================================================
        //
        // 最近5次采样全部都是“按下电平”
        //
        // 并且之前的稳定状态还是“松开”
        //
        // 说明：
        // 松开 → 按下
        //

        if(
            (key_status_reg == {5{~KEY_UNPRESSED}})
            &&
            (key_state == KEY_UNPRESSED)
        )
        begin

            key_state  <= ~KEY_UNPRESSED;

            key_press  <= 1'b1;
            key_change <= 1'b1;

        end


        //==================================================
        // 检测稳定松开
        //==================================================
        //
        // 最近5次采样全部都是“松开电平”
        //
        // 并且之前的稳定状态处于“按下”
        //
        // 说明：
        // 按下 → 松开
        //

        else if(
            (key_status_reg == {5{KEY_UNPRESSED}})
            &&
            (key_state != KEY_UNPRESSED)
        )
        begin

            key_state   <= KEY_UNPRESSED;

            key_release <= 1'b1;
            key_change  <= 1'b1;

        end

    end
end


endmodule